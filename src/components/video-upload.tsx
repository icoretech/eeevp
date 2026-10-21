"use client";

// Upload controls expose worker progress and keep the completed video's direct library navigation available.
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { LockGlyph, VideoGlyph } from "@/components/video-glyphs";
import {
  type UploadCompletion,
  type UploadProgress,
  useVideoUpload,
} from "@/hooks/use-video-upload";
import { formatVideoSize } from "@/lib/video/format";

function phaseLabel(progress: UploadProgress) {
  if (progress.phase === "encrypting") return "Encrypting in your browser";
  if (progress.phase === "completing") return "Verifying encrypted upload";
  return "Uploading encrypted chunks";
}

function UploadStatus({
  progress,
  onCancel,
}: {
  progress: UploadProgress;
  onCancel: () => void;
}) {
  const percent = Math.min(
    100,
    Math.round((progress.completed / progress.total) * 100),
  );
  return (
    <div className="upload-progress" role="status" aria-live="polite">
      <div className="progress-caption">
        <span>{phaseLabel(progress)}</span>
        <span>{percent}%</span>
      </div>
      <Progress value={percent} aria-label="Encrypted upload progress" />
      <p>
        {formatVideoSize(progress.completed)} of{" "}
        {formatVideoSize(progress.total)} · keep this tab open
      </p>
      {progress.phase !== "completing" && (
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel upload
        </Button>
      )}
    </div>
  );
}

export function VideoUpload({
  completed,
  onComplete,
  onReset,
}: {
  completed: UploadCompletion | null;
  onComplete: (video: UploadCompletion) => void;
  onReset: () => void;
}) {
  const upload = useVideoUpload(onComplete, onReset);
  const disabled =
    upload.demoMode || upload.progress !== null || !upload.library;
  return (
    <aside
      className="upload-section"
      id="upload"
      aria-labelledby="upload-heading"
      tabIndex={-1}
    >
      <Card className="upload-card">
        <CardHeader>
          <div className="upload-card-top">
            <span className="eyebrow">ADD TO YOUR LIBRARY</span>
            <Badge variant="outline">
              {upload.demoMode ? "Read-only demo" : "Private"}
            </Badge>
          </div>
          <CardTitle id="upload-heading">Upload a video.</CardTitle>
          <CardDescription>
            Your browser encrypts the original and its filename before upload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-5">
            <FieldGroup>
              <Field data-disabled={disabled}>
                <FieldLabel htmlFor="video-file">Choose your video</FieldLabel>
                <Input
                  ref={upload.input}
                  id="video-file"
                  type="file"
                  accept="video/mp4,video/webm"
                  disabled={disabled}
                  onChange={(event) =>
                    upload.chooseFile(
                      event.currentTarget.files?.item(0) ?? null,
                    )
                  }
                />
                <FieldDescription>
                  {upload.demoMode
                    ? "Read-only demo. Uploads are disabled."
                    : upload.library
                      ? "MP4 or WebM, up to 2 GB. No transcoding."
                      : "An encryption key that can create a library is needed to upload videos."}
                </FieldDescription>
              </Field>
            </FieldGroup>
            {upload.selectedFile && !upload.progress && (
              <div className="selected-file">
                <VideoGlyph />
                <div>
                  <strong>{upload.selectedFile.name}</strong>
                  <span>
                    {formatVideoSize(upload.selectedFile.size)} · ready to
                    encrypt
                  </span>
                </div>
              </div>
            )}
            {upload.progress ? (
              <UploadStatus
                progress={upload.progress}
                onCancel={upload.cancel}
              />
            ) : (
              <Button
                className="w-full"
                disabled={
                  upload.demoMode || !upload.selectedFile || !upload.library
                }
                onClick={upload.start}
              >
                Encrypt & upload<span aria-hidden="true">↗</span>
              </Button>
            )}
          </div>
          {upload.error && (
            <Alert variant="destructive" className="mt-5">
              <AlertTitle>Upload needs attention</AlertTitle>
              <AlertDescription>{upload.error}</AlertDescription>
            </Alert>
          )}
          {completed && (
            <Alert className="mt-5">
              <AlertTitle>Video added to your library</AlertTitle>
              <AlertDescription>
                {completed.name}
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={`/watch/${completed.id}`} />}
                >
                  Watch video
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter className="upload-card-footer">
          <div className="upload-security-note">
            <LockGlyph />
            <span>
              AES-256-GCM encryption
              <br />
              Protected by your encryption key
            </span>
          </div>
        </CardFooter>
      </Card>
    </aside>
  );
}
