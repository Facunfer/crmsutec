export function StatTile({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-4 shadow-sm ${highlight ? "bg-brand-600 text-white" : "bg-white text-brand-900"}`}>
      <p className="text-2xl font-semibold">{value}</p>
      <p className={`text-sm ${highlight ? "text-brand-100" : "text-brand-500"}`}>{label}</p>
    </div>
  );
}
