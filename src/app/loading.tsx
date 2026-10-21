// A synchronous fallback keeps streaming navigation inside the persistent shell and React's native transition handoff.
import { ViewTransition } from "react";

export default function Loading() {
  return (
    <ViewTransition
      default="none"
      enter={{
        "nav-forward": "page-forward",
        "nav-back": "page-back",
        default: "page-enter",
      }}
      exit="page-exit"
    >
      <div className="route-loading" role="status">
        Opening EEEVP<span aria-hidden="true">...</span>
      </div>
    </ViewTransition>
  );
}
