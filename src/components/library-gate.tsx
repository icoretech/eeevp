"use client";

// Key entry opens the workspace without checking the key; recovery text is read locally into the same field.
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  KeyRoundIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";
import { useFormStatus } from "react-dom";
import { useLibrary } from "@/components/library-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  normalizeLibraryKeyInput,
  serializeLibraryKeyRecovery,
} from "@/lib/crypto/key-input";
import { createLibraryKey } from "@/lib/crypto/library-crypto";

function SubmitButton({ importing }: { importing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending || importing}
      className="w-full"
      size="lg"
    >
      {pending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <KeyRoundIcon data-icon="inline-start" />
      )}
      Decrypt &amp; Login
    </Button>
  );
}

function LoginForm() {
  const { enter, lock, status, error, demoMode, demoPublicKey } = useLibrary();
  const keyInput = useRef<HTMLInputElement>(null);
  const importRevision = useRef(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [formError, action, pending] = useActionState(
    async (_previous: string | null) => {
      importRevision.current += 1;
      setImporting(false);
      setImportError(null);
      const input = keyInput.current?.value;
      if (!input?.trim()) return "Enter your encryption key.";
      try {
        await enter(input);
        return null;
      } catch (failure) {
        return failure instanceof Error
          ? failure.message
          : "The library could not be opened.";
      } finally {
        if (keyInput.current) keyInput.current.value = "";
      }
    },
    null,
  );
  const message = importError || error || formError;

  useEffect(
    () => () => {
      importRevision.current += 1;
    },
    [],
  );

  async function importRecoveryFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.item(0);
    event.currentTarget.value = "";
    if (!file) return;
    const request = ++importRevision.current;
    setImportError(null);
    setImporting(true);
    try {
      if (file.size > 8192) throw new Error("Recovery file is too large");
      const key = normalizeLibraryKeyInput(await file.text());
      if (!key) throw new Error("Recovery file is empty");
      if (request !== importRevision.current) return;
      if (keyInput.current) {
        keyInput.current.value = key;
        keyInput.current.focus();
      }
    } catch {
      if (request !== importRevision.current) return;
      setImportError("Choose a valid EEEVP recovery .txt file, up to 8 KiB.");
    } finally {
      if (request === importRevision.current) setImporting(false);
    }
  }

  function generateRecoveryKey() {
    const input = keyInput.current;
    if (!input) return;
    importRevision.current += 1;
    setImporting(false);
    setImportError(null);
    try {
      const key = createLibraryKey();
      const file = new Blob([serializeLibraryKeyRecovery(key)], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(file);
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      const download = document.createElement("a");
      download.href = url;
      download.download = "eeevp-library-key.txt";
      download.click();
      input.value = key;
      input.focus();
    } catch {
      setImportError(
        "A recovery key could not be generated. Please try again.",
      );
    }
  }

  return (
    <Card className="gate-card w-full">
      <CardContent>
        <form action={action} autoComplete="off">
          <FieldGroup>
            <Field data-invalid={Boolean(message)}>
              <FieldLabel htmlFor="encryption-key">Encryption key</FieldLabel>
              <Input
                ref={keyInput}
                defaultValue={demoMode ? demoPublicKey : undefined}
                id="encryption-key"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={4096}
                disabled={pending}
                aria-invalid={Boolean(message)}
                aria-describedby="encryption-key-description"
                onInput={() => {
                  importRevision.current += 1;
                  setImporting(false);
                  setImportError(null);
                }}
              />
              <FieldDescription id="encryption-key-description">
                {demoMode
                  ? "Public demo key. Browsing and playback only."
                  : "Your key stays in this browser session. Reloading or locking clears it."}
              </FieldDescription>
            </Field>
            {message ? <FieldError>{message}</FieldError> : null}
            <Field>
              <SubmitButton importing={importing} />
            </Field>
            {!demoMode ? (
              <FieldGroup>
                <Field>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-expanded={advancedOpen}
                    aria-controls="advanced-key-tools"
                    disabled={pending}
                    onClick={() => {
                      importRevision.current += 1;
                      setImporting(false);
                      setImportError(null);
                      setAdvancedOpen((open) => !open);
                    }}
                  >
                    Advanced key tools
                    {advancedOpen ? (
                      <ChevronUpIcon data-icon="inline-end" />
                    ) : (
                      <ChevronDownIcon data-icon="inline-end" />
                    )}
                  </Button>
                </Field>
                <FieldGroup id="advanced-key-tools" hidden={!advancedOpen}>
                  <Field>
                    <FieldLabel htmlFor="recovery-file">
                      Import .txt recovery file
                    </FieldLabel>
                    <Input
                      id="recovery-file"
                      type="file"
                      accept=".txt,text/plain"
                      disabled={pending || importing}
                      onChange={(event) => void importRecoveryFile(event)}
                      aria-describedby="recovery-file-description"
                    />
                    <FieldDescription id="recovery-file-description">
                      {importing
                        ? "Reading your recovery file on this device..."
                        : "Fills the encryption key field. The file stays on this device."}
                    </FieldDescription>
                  </Field>
                  <Field>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={generateRecoveryKey}
                      disabled={pending || importing}
                      aria-describedby="generate-key-description"
                    >
                      <DownloadIcon data-icon="inline-start" />
                      Generate a new library key
                    </Button>
                    <FieldDescription id="generate-key-description">
                      For a new library. Downloads a recovery file; existing
                      videos still need their original key.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </FieldGroup>
            ) : null}
          </FieldGroup>
        </form>
      </CardContent>
      {status === "locked" ? (
        <CardFooter className="justify-end">
          <Button
            variant="ghost"
            type="button"
            onClick={() => {
              importRevision.current += 1;
              setImporting(false);
              void lock();
            }}
            disabled={pending}
          >
            Retry sign out
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function LibraryGate({ children }: { children: ReactNode }) {
  const { status } = useLibrary();
  if (status === "open") return children;
  return (
    <section className="library-gate mx-auto flex w-full max-w-lg flex-col gap-6 py-12 md:py-20">
      <div className="gate-heading flex flex-col gap-3">
        <h1 className="text-4xl font-medium tracking-tight">
          Unlock your library
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Decryption happens in your browser.
        </p>
      </div>
      <LoginForm />
    </section>
  );
}
