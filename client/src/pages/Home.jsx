export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-4xl font-bold">Pact</h1>
      <p className="text-pine-soft">Plan the trip together. Nobody fronts the money.</p>
      <button className="rounded-full bg-coral px-6 py-3 font-medium text-cloud hover:bg-coral-dark">
        Get started
      </button>
    </main>
  );
}
