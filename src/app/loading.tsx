// Route transitions retain a quiet, accessible loading state without simulated video content.
export default function Loading() {
  return (
    <div className="route-loading" role="status">
      Opening EEEVP<span aria-hidden="true">...</span>
    </div>
  );
}
