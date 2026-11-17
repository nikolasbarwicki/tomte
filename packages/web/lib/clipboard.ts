import { toast } from "sonner";

/** Copies `text` and says so in a toast, naming `what` was copied; a refusal by the browser is shown as a toast too. */
export async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}
