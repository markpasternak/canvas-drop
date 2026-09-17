import { useState } from "react";
import {
  type AdminConnection,
  type AdminConnectionCanvas,
  ApiError,
  type PublicConnectionPolicy,
} from "../lib/api.js";
import { usePublicConnectionPolicy } from "../lib/mutations.js";
import { Button } from "./Button.js";
import { Field, TextareaField } from "./Field.js";
import { InlineNotice } from "./Surface.js";
import { useToast } from "./Toast.js";

export function PublicConnectionGrant({
  profile,
  canvas,
}: {
  profile: AdminConnection;
  canvas: AdminConnectionCanvas;
}) {
  const current = canvas.publicPolicy;
  const [editing, setEditing] = useState(false);
  const [paths, setPaths] = useState(current?.paths.join("\n") ?? "");
  const [methods, setMethods] = useState(current?.methods ?? profile.allowedMethods.slice(0, 1));
  const [limit, setLimit] = useState(String(current?.requestsPerDay ?? 500));
  const [error, setError] = useState("");
  const mutation = usePublicConnectionPolicy();
  const toast = useToast();
  const used = canvas.publicDay === Math.floor(Date.now() / 86_400_000) ? canvas.publicRequests : 0;

  async function save(policy: PublicConnectionPolicy | null) {
    setError("");
    try {
      await mutation.mutateAsync({ id: profile.id, canvasId: canvas.id, policy });
      setEditing(false);
      toast(
        policy
          ? `Public connection enabled for ${canvas.title}`
          : `Public connection disabled for ${canvas.title}`,
      );
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Could not save public access. Try again.",
      );
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Public access {current ? "enabled" : "off"}</p>
          {current && (
            <p className="text-xs text-muted">
              {used ?? 0} / {current.requestsPerDay.toLocaleString()} requests today · resets at
              midnight UTC
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Cancel" : current ? "Edit public access" : "Configure public access"}
          </Button>
          {current && (
            <Button
              size="sm"
              variant="ghost"
              loading={mutation.isPending}
              onClick={() => void save(null)}
            >
              Disable public access
            </Button>
          )}
        </div>
      </div>
      {current && !editing && (
        <p className="break-all font-mono text-xs text-muted">
          {current.methods.join(", ")} · {current.paths.join(", ")}
        </p>
      )}
      {editing && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              paths: paths
                .split("\n")
                .map((path) => path.trim())
                .filter(Boolean),
              methods,
              requestsPerDay: Number(limit),
            });
          }}
        >
          <p className="text-xs text-muted">
            Anyone who can open this canvas can call these endpoints using the connection's
            credentials. The canvas must have a public link, Backend on, and Connections allowed for
            viewers. Other backend features remain restricted.
          </p>
          <TextareaField
            label="Public endpoint paths"
            description="One exact path per line. Query strings and redirects are blocked."
            rows={3}
            placeholder="/v1/analyze"
            value={paths}
            onChange={(event) => setPaths(event.target.value)}
            required
            mono
          />
          <fieldset className="flex flex-wrap gap-3" disabled={mutation.isPending}>
            <legend className="mb-1 text-sm font-medium">Public methods</legend>
            {profile.allowedMethods.map((method) => (
              <label key={method} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={methods.includes(method)}
                  onChange={(event) =>
                    setMethods(
                      event.target.checked
                        ? [...methods, method]
                        : methods.filter((item) => item !== method),
                    )
                  }
                />
                {method}
              </label>
            ))}
          </fieldset>
          <Field
            label="Public requests per day"
            type="number"
            min={1}
            max={1_000_000}
            step={1}
            required
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            description="Shared across all public visitors. Upstream calls may incur charges; this is a request cap, not a spending cap."
          />
          <Button
            size="sm"
            type="submit"
            disabled={methods.length === 0}
            loading={mutation.isPending}
          >
            {current ? "Save public access" : "Enable public access"}
          </Button>
        </form>
      )}
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
    </div>
  );
}
