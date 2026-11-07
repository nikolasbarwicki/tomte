/**
 * Runs `change` (a theme switch) with every CSS transition off, so the whole page flips at once instead of fading piecemeal. This is what
 * next-themes' `disableTransitionOnChange` does, but that injects an inline `<style>` the Content-Security-Policy blocks; here the rule is
 * `html.theme-switching` in `tailwind.css`.
 */
export function withoutTransitions(change: () => void) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  change();
  // Reading a computed style forces the browser to apply the new theme while transitions are still off.
  void window.getComputedStyle(document.body).opacity;
  setTimeout(() => root.classList.remove("theme-switching"), 1);
}
