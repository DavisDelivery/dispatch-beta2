/**
 * PrintButton — triggers window.print() to produce a clean printed manifest.
 * Styled with .tool-btn (same as other tool buttons). Tap target >= 44px.
 * No props needed; behaviour is purely presentational.
 */
export default function PrintButton() {
  return (
    <button
      type="button"
      className="tool-btn print-btn"
      onClick={() => window.print()}
      title="Print this manifest"
    >
      ⎙ Print
    </button>
  )
}
