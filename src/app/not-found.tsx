// Invalid video identifiers never reveal storage details or fall through to a public listing.
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="page-message">
      <p className="eyebrow">404 / NOT FOUND</p>
      <h1>This page is out of frame.</h1>
      <p>Return to your private video library to find a video.</p>
      <Button
        nativeButton={false}
        render={<Link href="/" transitionTypes={["nav-back"]} />}
      >
        Open library
      </Button>
    </div>
  );
}
