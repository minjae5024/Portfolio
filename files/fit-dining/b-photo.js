// B′ 사진 수정 부하 시나리오(k6). 리뷰 사진을 한 장씩 바꾸는 수정(edit)과, 같은 시각의 리뷰 목록 읽기(read)를 함께 보낸다.
// edit: 업로드 주소 받기 → 저장소에 원본·썸네일 PUT → PATCH /reviews/{id} {photos:[새 업로드 id]} (기존 사진은 빠진다)
// read: GET /places/1/reviews (로그인 없음) — 사진 수정과 상관없는 "다른 API"
// 환경 변수: EDIT_VUS, READ_VUS, ITERS(>0이면 edit를 VU당 그 횟수만), DURATION, DEMO_EMAIL, DEMO_PASSWORD
import http from "k6/http";
import exec from "k6/execution";
import encoding from "k6/encoding";
import { check } from "k6";
import { Trend } from "k6/metrics";

// isolated(1 VU, 순서대로)에서만 쓴다: PATCH 직전·직후 연결 풀 지표의 차이 = 그 요청이 DB 연결을 쥔 시간 합
const METRICS = __ENV.METRICS || "http://host.docker.internal:8081/actuator/prometheus";
const PER_PATCH = __ENV.PER_PATCH === "1";
const dbHold = new Trend("db_hold_ms_per_patch");
const dbCheckouts = new Trend("db_checkouts_per_patch");

function hikari() {
  const text = http.get(METRICS, { tags: { name: "metrics" } }).body;
  const pick = (name) => Number((text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, "m")) || [])[1]);
  return { sum: pick("hikaricp_connections_usage_seconds_sum"), count: pick("hikaricp_connections_usage_seconds_count") };
}

const BASE = __ENV.BASE || "http://host.docker.internal:8080";
const S3 = __ENV.S3 || "http://garage:3900";
const S3_HOST = __ENV.S3_HOST || "127.0.0.1:13900";
const ORIGIN = "http://localhost:3000";
const EDIT_VUS = Number(__ENV.EDIT_VUS || 1);
const READ_VUS = Number(__ENV.READ_VUS || 0);
const ITERS = Number(__ENV.ITERS || 0);
const DURATION = __ENV.DURATION || "60s";

// 1x1 JPEG. BE는 크기와 앞 3바이트(FF D8 FF)만 본다
const JPEG = encoding.b64decode(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "std",
);

const scenarios = {
  edit: ITERS > 0
    ? { executor: "per-vu-iterations", exec: "edit", vus: EDIT_VUS, iterations: ITERS, maxDuration: "20m" }
    : { executor: "constant-vus", exec: "edit", vus: EDIT_VUS, duration: DURATION },
};
if (READ_VUS > 0) scenarios.read = { executor: "constant-vus", exec: "read", vus: READ_VUS, duration: DURATION };

export const options = {
  scenarios,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  // 이름별 지표를 요약에 따로 남긴다
  thresholds: {
    "http_req_duration{name:patch}": ["max>=0"],
    "http_req_duration{name:list}": ["max>=0"],
    "http_req_failed{name:patch}": ["rate>=0"],
    "http_req_failed{name:list}": ["rate>=0"],
  },
};

export function setup() {
  const res = http.post(`${BASE}/api/auth/login`,
    JSON.stringify({ email: __ENV.DEMO_EMAIL, password: __ENV.DEMO_PASSWORD }),
    { headers: { "Content-Type": "application/json", Origin: ORIGIN }, tags: { name: "login" } });
  check(res, { "login 200": (r) => r.status === 200 });
  return { token: res.json("accessToken") };
}

let reviewId = null;

function auth(data) {
  return { Authorization: `Bearer ${data.token}`, "Content-Type": "application/json" };
}

function todayKst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function edit(data) {
  if (reviewId === null) {
    // VU마다 다른 장소에 자기 리뷰를 하나 만든다(같은 회원·장소·날짜는 하나만)
    const place = exec.vu.idInTest;
    const res = http.post(`${BASE}/api/v1/places/${place}/reviews`,
      JSON.stringify({ visitedAt: todayKst(), tagCodes: ["COZY_GOOD"], revisitIntent: true }),
      { headers: auth(data), tags: { name: "create" } });
    check(res, { "create 201": (r) => r.status === 201 });
    reviewId = res.json("reviewId");
  }
  const urls = http.post(`${BASE}/api/v1/review-photos/upload-urls`, JSON.stringify({ count: 1 }),
    { headers: auth(data), tags: { name: "upload-urls" } });
  if (!check(urls, { "upload-urls 2xx": (r) => r.status >= 200 && r.status < 300 })) return;
  const up = urls.json("uploads")[0];
  for (const url of [up.uploadUrl, up.thumbUploadUrl]) {
    const put = http.put(`${S3}${url}`, JPEG,
      { headers: { "Content-Type": "image/jpeg", Host: S3_HOST }, tags: { name: "put" } });
    check(put, { "put 200": (r) => r.status === 200 });
  }
  const before = PER_PATCH ? hikari() : null;
  const patch = http.patch(`${BASE}/api/v1/reviews/${reviewId}`, JSON.stringify({ photos: [up.photoId] }),
    { headers: auth(data), tags: { name: "patch" }, timeout: "120s" });
  if (!check(patch, { "patch 204": (r) => r.status === 204 })) {
    console.warn(`patch failed status=${patch.status} error=${patch.error_code} ${patch.error} ms=${Math.round(patch.timings.duration)}`);
  }
  if (PER_PATCH) {
    const after = hikari();
    dbHold.add((after.sum - before.sum) * 1000);
    dbCheckouts.add(after.count - before.count);
  }
}

export function read() {
  const res = http.get(`${BASE}/api/v1/places/1/reviews`, { tags: { name: "list" }, timeout: "120s" });
  if (!check(res, { "list 200": (r) => r.status === 200 })) {
    console.warn(`list failed status=${res.status} error=${res.error_code} ${res.error} ms=${Math.round(res.timings.duration)}`);
  }
}
