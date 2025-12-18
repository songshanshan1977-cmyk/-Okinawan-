export default function Step5Confirmation({ initialData, onNext, onBack }) {
  return (
    <div style={{ padding: 40 }}>
      <h1>Step5：支付成功（测试版）</h1>

      <pre style={{ background: "#f5f5f5", padding: 16 }}>
        {JSON.stringify(initialData, null, 2)}
      </pre>

      <div style={{ marginTop: 24 }}>
        <button onClick={onBack}>返回</button>
        <button onClick={onNext} style={{ marginLeft: 12 }}>
          前往 Step6
        </button>
      </div>
    </div>
  );
}
