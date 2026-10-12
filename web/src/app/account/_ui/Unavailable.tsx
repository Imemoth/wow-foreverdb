export function Unavailable() {
  return (
    <div className="panel space-y-2 p-6" role="alert">
      <h1 className="panel-title text-2xl">Temporarily unavailable</h1>
      <p className="text-mist">We could not reach the service. You are still signed in; reload in a moment.</p>
    </div>
  );
}
