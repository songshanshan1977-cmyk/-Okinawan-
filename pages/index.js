export async function getServerSideProps({ res }) {
  // 让根首页直接“消失”，加速从 Google 结果清掉
  res.statusCode = 410;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Gone");
  return { props: {} };
}

export default function Gone() {
  return null;
}
