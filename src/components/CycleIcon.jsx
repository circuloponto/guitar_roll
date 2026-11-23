// A "cycle" loop icon in the style of a DAW cycle button: an open circle with an arrowhead (turned upside down).
// Drawn here (not a copy of any app's artwork) and sized/stroked like the Lucide icons.
export default function CycleIcon({ size = 18, strokeWidth = 2.2 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: 'rotate(180deg)' }}
    >
      <path d="M16.6 6.4 A7.2 7.2 0 1 1 7.4 6.4" />
      <polygon points="10.2 4.4 8.9 8.9 5.4 5" fill="currentColor" />
    </svg>
  );
}
