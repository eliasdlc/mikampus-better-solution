// El sello de ciclo (plan §11): ninguna vista con horario mezcla ciclos sin
// decirlo. Muestra la etiqueta del término ("Abril de 2026") como un chip
// discreto. La etiqueta es el dato honesto y ya legible; no se inventa un rango
// de meses que el portal no dio.
export function TermBadge({ label, className = '' }: { label: string | null | undefined; className?: string }) {
  if (!label) return null;
  return (
    <span
      className={`border-line text-muted inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${className}`}
    >
      {label}
    </span>
  );
}
