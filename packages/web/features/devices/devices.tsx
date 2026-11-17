import type { DeviceEntry } from "@tomte/contract/api";
import { CheckIcon, CopyIcon, Laptop, Plus } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { confirmAction } from "@/components/confirm.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { probeSession } from "@/host/api.ts";
import { dateTime } from "@/lib/format.ts";

import { createPairingCode, listDevices, revokeDevice } from "./api.ts";

/** The paired devices section of Settings: every paired device, with revoking and new pairing codes. */
export function Devices() {
  const [devices, setDevices] = useState<DeviceEntry[]>();
  const [error, setError] = useState<string>();
  const [code, setCode] = useState<string>();
  const [creating, startCreating] = useTransition();

  const refresh = useCallback(
    () =>
      listDevices().then(
        (d) => {
          setDevices(d);
          setError(undefined);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const newCode = () =>
    startCreating(async () => {
      try {
        setCode(await createPairingCode());
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Paired devices</h3>
          <p className="text-muted-foreground text-xs">
            Browsers and scripts paired with this host. Revoking a device signs it out at once.
          </p>
        </div>
        <Button size="sm" disabled={creating} onClick={newCode}>
          {creating ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          Pair a device
        </Button>
      </div>
      <PairingCodeDialog code={code} onClose={() => setCode(undefined)} />
      {error && <p className="text-destructive text-sm break-words">{error}</p>}
      {devices && (
        <Card>
          <CardContent className="flex flex-col divide-y">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} onRevoked={() => void refresh()} />
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function DeviceRow({ device: d, onRevoked }: { device: DeviceEntry; onRevoked: () => void }) {
  const [revoking, startRevoking] = useTransition();
  const revoke = async () => {
    const ok = await confirmAction({
      title: `Revoke "${d.name}"?`,
      description: d.current
        ? "This is the device you are using. You will be signed out and must pair again."
        : "It loses access at once and must pair again with a new code.",
      action: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    startRevoking(async () => {
      if (!(await revokeDevice(d.id))) return;
      if (d.current) await probeSession();
      else onRevoked();
    });
  };
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <Laptop className="text-muted-foreground size-5 shrink-0" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{d.name}</span>
          {d.current && <Badge variant="secondary">This device</Badge>}
        </div>
        <span className="text-muted-foreground text-xs">
          Paired {dateTime(d.createdAt)} ·{" "}
          {d.lastSeenAt === null ? "Never active" : `Last active ${dateTime(d.lastSeenAt)}`}
        </span>
      </div>
      <Button variant="outline" size="sm" disabled={revoking} onClick={() => void revoke()}>
        {revoking && <Spinner data-icon="inline-start" />}
        Revoke
      </Button>
    </div>
  );
}

function PairingCodeDialog({ code, onClose }: { code: string | undefined; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog open={code !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pairing code</DialogTitle>
          <DialogDescription>
            Enter this code on the new device. It works once and expires in 10 minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
          <code className="font-mono text-xl tracking-widest">{code}</code>
          <Button variant="ghost" size="icon-sm" aria-label="Copy code" onClick={() => void copy()}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
