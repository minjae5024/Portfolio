// 사진 저장소(Garage S3) 앞에 두는 지연 프록시. BE의 S3_ENDPOINT만 이 프록시를 가리킨다.
// 저장소가 보내는 응답 바이트를 DELAY_MS만큼 늦춰, 요청마다 응답이 그만큼 늦게 오는 느린 저장소를 흉내 낸다.
// 실행: node delay-proxy.js <듣는 포트> <대상 호스트:포트> <지연 ms>
const net = require("net");

const [listenPort, target, delayArg] = process.argv.slice(2);
const [host, port] = target.split(":");
const delay = Number(delayArg ?? 0);

net.createServer((client) => {
  const upstream = net.connect(Number(port), host);
  let chain = Promise.resolve();
  upstream.on("data", (chunk) => {
    client.pause();
    chain = chain.then(() => new Promise((done) => setTimeout(() => {
      if (!client.destroyed) client.write(chunk);
      done();
    }, delay)));
    chain.then(() => client.resume());
  });
  client.on("data", (chunk) => upstream.write(chunk));
  const close = () => { client.destroy(); upstream.destroy(); };
  upstream.on("end", () => chain.then(() => client.end()));
  client.on("end", () => upstream.end());
  upstream.on("error", close);
  client.on("error", close);
}).listen(Number(listenPort), "127.0.0.1", () => {
  console.log(`delay-proxy 127.0.0.1:${listenPort} -> ${target}, ${delay}ms`);
});
