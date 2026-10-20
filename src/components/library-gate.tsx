"use client";

// Authentication and browser-only key entry are separate steps before private video access.
import { DownloadIcon, KeyRoundIcon, LockKeyholeIcon } from "lucide-react";
import { type ReactNode, useActionState, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useLibrary } from "@/components/library-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { createLibraryKey } from "@/lib/crypto/library-crypto";

function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full" size="lg">
      {pending ? <Spinner data-icon="inline-start" /> : null}
      {children}
    </Button>
  );
}

function GateError({ message }: { message: string | null }) {
  return message ? <FieldError>{message}</FieldError> : null;
}

function LoginForm() {
  const { authenticate, error } = useLibrary();
  const passwordInput = useRef<HTMLInputElement>(null);
  const [formError, action, pending] = useActionState(
    async (_previous: string | null) => {
      const password = passwordInput.current?.value;
      if (!password) return "Enter your library password.";
      try {
        await authenticate(password);
        return null;
      } catch {
        return "Could not sign in. Check your password and retry.";
      } finally {
        if (passwordInput.current) passwordInput.current.value = "";
      }
    },
    null,
  );

  return (
    <Card className="gate-card w-full">
      <CardHeader>
        <CardTitle>Sign in to EEEVP</CardTitle>
        <CardDescription>
          Enter the library password to access your private video collection.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action}>
          <FieldGroup>
            <Field data-invalid={Boolean(error || formError)}>
              <FieldLabel htmlFor="library-password">
                Library password
              </FieldLabel>
              <Input
                ref={passwordInput}
                id="library-password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
                disabled={pending}
                aria-invalid={Boolean(error || formError)}
                aria-describedby="library-password-description"
              />
              <FieldDescription id="library-password-description">
                Your encryption key is entered separately in your browser.
              </FieldDescription>
            </Field>
            <GateError message={error || formError} />
            <Field>
              <SubmitButton>Sign in</SubmitButton>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          The password grants access. Your library key decrypts your videos.
        </p>
      </CardFooter>
    </Card>
  );
}

function UnlockForm() {
  const { unlock, lock, error } = useLibrary();
  const keyInput = useRef<HTMLInputElement>(null);
  const [formError, action, pending] = useActionState(
    async (_previous: string | null) => {
      const key = keyInput.current?.value.trim();
      if (!key) return "Enter your saved library key.";
      try {
        await unlock(key);
        return null;
      } catch {
        return "Could not unlock your library. Check your saved library key.";
      } finally {
        if (keyInput.current) keyInput.current.value = "";
      }
    },
    null,
  );

  return (
    <Card className="gate-card w-full">
      <CardHeader>
        <CardTitle>Unlock your library</CardTitle>
        <CardDescription>
          Enter the library key saved when this library was created. Videos are
          decrypted only in your browser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} autoComplete="off">
          <FieldGroup>
            <Field data-invalid={Boolean(error || formError)}>
              <FieldLabel htmlFor="library-key">Library key</FieldLabel>
              <Input
                ref={keyInput}
                id="library-key"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                disabled={pending}
                aria-invalid={Boolean(error || formError)}
                aria-describedby="library-key-description"
              />
              <FieldDescription id="library-key-description">
                The key stays in memory for this session. Enter it again after
                reloading or locking your library.
              </FieldDescription>
            </Field>
            <GateError message={error || formError} />
            <Field>
              <SubmitButton>Unlock library</SubmitButton>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Signed in. Library locked.
        </p>
        <Button
          variant="ghost"
          type="button"
          onClick={() => void lock()}
          disabled={pending}
        >
          Sign out
        </Button>
      </CardFooter>
    </Card>
  );
}

function saveRecoveryKey(key: string) {
  const file = new Blob(
    [
      "EEEVP library recovery key\n\n",
      key,
      "\n\nKeep this key private and safe. It decrypts your EEEVP library.\n",
      "Enter it after signing in on another device or after reloading.\n",
      "Your library password cannot replace this key.\n",
    ],
    { type: "text/plain;charset=utf-8" },
  );
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "eeevp-library-key.txt";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function SetupForm() {
  const { initialize, lock, error } = useLibrary();
  const [key, setKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [formError, action, pending] = useActionState(
    async (_previous: string | null) => {
      if (!key || !saved) return "Save your library key before continuing.";
      try {
        await initialize(key);
        return null;
      } catch {
        return "Could not initialize your library. Please retry.";
      }
    },
    null,
  );

  return (
    <Card className="gate-card w-full">
      <CardHeader>
        <CardTitle>Create your private library</CardTitle>
        <CardDescription>
          Create one encryption key for this library. Save it before adding your
          first video.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {key ? (
          <form action={action}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="new-library-key">
                  Your library key
                </FieldLabel>
                <Input
                  id="new-library-key"
                  value={key}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  aria-describedby="new-library-key-description"
                />
                <FieldDescription id="new-library-key-description">
                  This key never leaves your browser. Keep a private copy to
                  unlock your videos on this or another device.
                </FieldDescription>
              </Field>
              <Field>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => saveRecoveryKey(key)}
                  disabled={pending}
                >
                  <DownloadIcon data-icon="inline-start" />
                  Download recovery key
                </Button>
              </Field>
              <Alert>
                <KeyRoundIcon />
                <AlertTitle>Keep your key safe</AlertTitle>
                <AlertDescription>
                  If you lose this key, your videos cannot be recovered with the
                  library password.
                </AlertDescription>
              </Alert>
              <Field orientation="horizontal">
                <Checkbox
                  id="saved-library-key"
                  checked={saved}
                  onCheckedChange={setSaved}
                  disabled={pending}
                />
                <FieldContent>
                  <FieldLabel htmlFor="saved-library-key">
                    I saved my library key
                  </FieldLabel>
                  <FieldDescription>
                    I can find my saved copy when I need to unlock this library.
                  </FieldDescription>
                </FieldContent>
              </Field>
              <GateError message={error || formError} />
              <Field>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={!saved || pending}
                >
                  {pending ? <Spinner data-icon="inline-start" /> : null}
                  Initialize library
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <FieldGroup>
            <Alert>
              <LockKeyholeIcon />
              <AlertTitle>A key separate from your password</AlertTitle>
              <AlertDescription>
                Your browser encrypts and decrypts videos using this key. The
                server stores encrypted files.
              </AlertDescription>
            </Alert>
            <GateError message={error} />
            <Field>
              <Button
                type="button"
                size="lg"
                onClick={() => setKey(createLibraryKey())}
              >
                <KeyRoundIcon data-icon="inline-start" />
                Create library key
              </Button>
            </Field>
          </FieldGroup>
        )}
      </CardContent>
      <CardFooter className="justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          First-time library setup
        </p>
        <Button
          variant="ghost"
          type="button"
          onClick={() => void lock()}
          disabled={pending}
        >
          Sign out
        </Button>
      </CardFooter>
    </Card>
  );
}

export function LibraryGate({ children }: { children: ReactNode }) {
  const { status } = useLibrary();
  if (status === "unlocked") return children;
  return (
    <section className="library-gate mx-auto flex w-full max-w-lg flex-col gap-6 py-12 md:py-20">
      <div className="gate-heading flex flex-col gap-3">
        <p className="eyebrow">PRIVATE VIDEO LIBRARY</p>
        <h1 className="text-4xl font-medium tracking-tight">
          Your videos. Private.
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          A private home for your videos, encrypted before upload and decrypted
          when you watch.
        </p>
      </div>
      {status === "loading" ? (
        <Card>
          <CardHeader>
            <CardTitle>Opening your library</CardTitle>
            <CardDescription>Checking your access.</CardDescription>
          </CardHeader>
          <CardContent>
            <Spinner />
          </CardContent>
        </Card>
      ) : status === "signed-out" ? (
        <LoginForm />
      ) : status === "needs-setup" ? (
        <SetupForm />
      ) : (
        <UnlockForm />
      )}
    </section>
  );
}
