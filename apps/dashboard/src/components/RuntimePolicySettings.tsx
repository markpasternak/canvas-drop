import { useState } from "react";
import type { Canvas, CanvasCapabilitiesPatch } from "../lib/api.js";
import {
  type Audience,
  type DataPolicy,
  defaultPreset,
  emptyPolicy,
  type Operation,
  PRESETS,
  type Preset,
  RIGHT_LABELS,
  type Right,
  type RuntimePolicy,
} from "../lib/runtime-policy.js";
import { Button } from "./Button.js";
import { Section } from "./SettingsSection.js";

const control =
  "w-full min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-sm text-fg";
const operations: Operation[] = ["read", "create", "update", "delete", "increment"];
function RightSelect({
  label,
  value,
  onChange,
  audienceOnly = false,
}: {
  label: string;
  value: Right;
  onChange: (value: Right) => void;
  audienceOnly?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm text-muted">
      {label}
      <select className={control} value={value} onChange={(e) => onChange(e.target.value as Right)}>
        {Object.entries(RIGHT_LABELS)
          .filter(([key]) => !audienceOnly || ["none", "editors", "viewers"].includes(key))
          .map(([key, text]) => (
            <option key={key} value={key}>
              {text}
            </option>
          ))}
      </select>
    </label>
  );
}
function DataSettings({
  name,
  policy,
  onChange,
  files,
}: {
  name: string;
  policy: DataPolicy;
  onChange: (policy: DataPolicy) => void;
  files: boolean;
}) {
  return (
    <div className="space-y-3">
      <label className="grid gap-1 text-sm">
        Preset for {name}
        <select
          className={control}
          value={policy.preset}
          onChange={(e) => onChange({ preset: e.target.value as Preset })}
        >
          {Object.entries(PRESETS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">
        {Object.keys(policy.overrides ?? {}).length
          ? "Custom permissions. Review each operation below."
          : PRESETS[policy.preset].summary}
      </p>
      <details>
        <summary className="cursor-pointer text-sm text-accent">
          Customize operations for {name}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {operations
            .filter((op) => !files || op !== "increment")
            .map((op) => (
              <RightSelect
                key={op}
                label={`${name}: ${op === "update" && files ? "rename" : op}`}
                value={policy.overrides?.[op] ?? PRESETS[policy.preset].rules[op]}
                audienceOnly={op === "create"}
                onChange={(right) =>
                  onChange({ ...policy, overrides: { ...policy.overrides, [op]: right } })
                }
              />
            ))}
          {!files && (
            <RightSelect
              label={`${name}: see total count`}
              value={policy.aggregateCount ?? "none"}
              audienceOnly
              onChange={(value) => onChange({ ...policy, aggregateCount: value as Audience })}
            />
          )}
        </div>
      </details>
    </div>
  );
}

/** Keep the baseline while editing; background refetches cannot silently rebase a policy save. */
export function RuntimePolicySettings({
  canvas,
  save,
  pending,
  connectionKeys,
}: {
  canvas: Canvas;
  save: (patch: CanvasCapabilitiesPatch) => Promise<unknown>;
  pending: boolean;
  connectionKeys: string[];
}) {
  const [edit, setEdit] = useState<{ policy: RuntimePolicy; revision: string | null } | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"collections" | "fileGroups" | "channels">("collections");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const policy = edit?.policy ?? canvas.runtimePolicy ?? emptyPolicy();
  const change = (next: RuntimePolicy) => {
    setEdit({
      policy: next,
      revision: edit ? edit.revision : (canvas.runtimePolicyRevision ?? null),
    });
    setError("");
    setSaved(false);
  };
  const addResource = () => {
    const key = name.trim();
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(key) ||
      key === "prototype" ||
      key in Object.prototype
    ) {
      setError("Use 1–80 letters, digits, dots, colons, underscores or hyphens.");
      return;
    }
    if (Object.hasOwn(policy[kind], key)) {
      setError("That resource already exists.");
      return;
    }
    if (Object.keys(policy[kind]).length >= 50) {
      setError("A canvas can configure up to 50 resources of each type.");
      return;
    }
    const value =
      kind === "channels"
        ? {
            subscribe: "viewers",
            publish: policy.defaultMode === "read_only" ? "editors" : "viewers",
            seePresence: "viewers",
            participatePresence: "viewers",
          }
        : { preset: defaultPreset(policy.defaultMode) };
    change({ ...policy, [kind]: { ...policy[kind], [key]: value } });
    setName("");
  };
  const baseline = canvas.runtimePolicy ?? emptyPolicy();
  const changedResources = (
    ["collections", "fileGroups", "channels", "connections"] as const
  ).flatMap((type) =>
    Object.keys(policy[type])
      .filter((key) => JSON.stringify(policy[type][key]) !== JSON.stringify(baseline[type][key]))
      .map(
        (key) =>
          `${type === "fileGroups" ? "File group" : type === "collections" ? "Collection" : type === "channels" ? "Channel" : "Connection"}: ${key}`,
      ),
  );
  return (
    <Section
      id="primitive-policies"
      title="Participation and permissions"
      description="Choose a default, then add the collections, file groups or channels your canvas uses. Customize only when needed."
    >
      <fieldset
        disabled={pending || !canvas.backendEnabled || canvas.status === "disabled"}
        className="min-w-0 space-y-4"
      >
        <label className="grid gap-1 text-sm font-medium">
          Default for new resources
          <select
            aria-label="Default for new resources"
            className={control}
            value={policy.defaultMode}
            onChange={(e) =>
              change({ ...policy, defaultMode: e.target.value as RuntimePolicy["defaultMode"] })
            }
          >
            <option value="read_only">Read only</option>
            <option value="participation">Participation</option>
            <option value="collaboration">Collaboration</option>
          </select>
        </label>
        <p className="text-sm text-muted">
          {PRESETS[defaultPreset(policy.defaultMode)].summary} Existing resource permissions stay
          unchanged. Personal preferences stay private. AI, Connections and authoring have separate
          controls.
        </p>
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="grid gap-1 text-sm">
            Resource type
            <select
              className={control}
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="collections">Collection</option>
              <option value="fileGroups">File group</option>
              <option value="channels">Channel</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Resource name
            <input
              className={control}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="comments"
            />
          </label>
          <Button variant="secondary" onClick={addResource}>
            Add resource
          </Button>
        </div>
        <details>
          <summary className="cursor-pointer font-medium text-accent">Advanced permissions</summary>
          <div className="mt-4 space-y-4">
            {(["collections", "fileGroups"] as const).flatMap((type) =>
              Object.entries(policy[type]).map(([key, value]) => (
                <div key={`${type}:${key}`} className="rounded-lg border border-border p-3">
                  <p className="mb-2 break-all font-medium">
                    {type === "collections" ? "Collection" : "File group"}: {key}
                  </p>
                  <DataSettings
                    name={key}
                    policy={value}
                    files={type === "fileGroups"}
                    onChange={(next) =>
                      change({ ...policy, [type]: { ...policy[type], [key]: next } })
                    }
                  />
                </div>
              )),
            )}
            {Object.entries(policy.channels).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-border p-3">
                <p className="mb-3 break-all font-medium">Channel: {key}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["subscribe", "Receive messages"],
                      ["publish", "Publish messages"],
                      ["seePresence", "See who is present"],
                      ["participatePresence", "Appear in presence"],
                    ] as const
                  ).map(([op, label]) => (
                    <RightSelect
                      key={op}
                      label={`${key}: ${label}`}
                      value={value[op]}
                      audienceOnly
                      onChange={(next) =>
                        change({
                          ...policy,
                          channels: {
                            ...policy.channels,
                            [key]: { ...value, [op]: next as Audience },
                          },
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
            {Array.from(new Set([...connectionKeys, ...Object.keys(policy.connections)])).map(
              (key) => {
                const value = policy.connections[key];
                return (
                  <div key={key} className="space-y-3 rounded-lg border border-border p-3">
                    <p className="break-all font-medium">Connection: {key}</p>
                    <RightSelect
                      label={`${key}: access`}
                      value={value?.audience ?? canvas.connectionsAudience ?? "editors"}
                      audienceOnly
                      onChange={(audience) =>
                        change({
                          ...policy,
                          connections: {
                            ...policy.connections,
                            [key]: { ...value, audience: audience as Audience },
                          },
                        })
                      }
                    />
                    <p className="text-xs text-muted">
                      Allowed methods are also limited by the administrator's grant.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      {["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map(
                        (method) => (
                          <label key={method} className="flex items-center gap-1 text-sm">
                            <input
                              type="checkbox"
                              checked={!value?.methods || value.methods.includes(method)}
                              onChange={(e) => {
                                const current = value?.methods ?? [
                                  "GET",
                                  "HEAD",
                                  "POST",
                                  "PUT",
                                  "PATCH",
                                  "DELETE",
                                  "OPTIONS",
                                ];
                                change({
                                  ...policy,
                                  connections: {
                                    ...policy.connections,
                                    [key]: {
                                      audience:
                                        value?.audience ?? canvas.connectionsAudience ?? "editors",
                                      methods: e.target.checked
                                        ? [...current, method]
                                        : current.filter((item) => item !== method),
                                    },
                                  },
                                });
                              }}
                            />
                            {method}
                          </label>
                        ),
                      )}
                    </div>
                  </div>
                );
              },
            )}
            <p className="text-xs text-muted">
              Attachments inherit their record's permissions. File updates rename the file;
              replacing its contents requires a new upload. Unconfigured collections and file groups
              cannot be used.
            </p>
          </div>
        </details>
        {edit && (
          <div className="space-y-2 rounded-lg border border-border p-3" aria-live="polite">
            <p className="font-medium">Review permission changes</p>
            <p className="text-sm text-muted">
              {policy.defaultMode !== baseline.defaultMode
                ? "The default changes for new resources only. "
                : ""}
              {changedResources.length
                ? "These resources will use the settings shown above, including existing items:"
                : "No existing resource permissions change."}
            </p>
            {changedResources.length > 0 && (
              <ul className="list-inside list-disc break-all text-sm">
                {changedResources.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                loading={pending}
                onClick={async () => {
                  try {
                    await save({
                      runtimePolicy: edit.policy,
                      expectedRuntimePolicy: edit.revision,
                    });
                    setEdit(null);
                    setSaved(true);
                  } catch {
                    setError(
                      "Couldn't save permissions. Reload the latest settings before trying again; your proposed changes are still shown.",
                    );
                  }
                }}
              >
                Save permissions
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setEdit(null);
                  setError("");
                }}
              >
                Discard changes
              </Button>
            </div>
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-muted">
          Permissions saved.
        </p>
      )}
    </Section>
  );
}
