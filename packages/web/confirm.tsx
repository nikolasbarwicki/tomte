import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ConfirmRequest = {
  title: string;
  description?: string;
  action: string;
  destructive?: boolean;
};
type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

let show: ((p: Pending) => void) | undefined;

/** Asks the user to confirm in a dialog; resolves to false when dismissed or when no `ConfirmHost` is mounted. */
export function confirmAction(req: ConfirmRequest): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  if (show) show({ ...req, resolve });
  else resolve(false);
  return promise;
}

/** Renders the dialog for `confirmAction`; mount once at the root. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    show = (p) => {
      setPending(p);
      setOpen(true);
    };
    return () => {
      show = undefined;
    };
  }, []);
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setOpen(false);
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          {pending?.description && (
            <AlertDialogDescription>{pending.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={pending?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {pending?.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
