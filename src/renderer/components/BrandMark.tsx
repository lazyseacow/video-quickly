export default function BrandMark({ size = 31 }: { size?: number }) {
  return <span className="brand-symbol" style={{ width: size, height: size }} aria-hidden="true" />;
}
