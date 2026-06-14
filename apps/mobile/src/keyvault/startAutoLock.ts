/**
 * App-background auto-lock wiring for the mobile secure runtime.
 *
 * POLICY = CLEAR-ON-BACKGROUND (no grace period): the instant the app resigns
 * active / is backgrounded, the FULL wallet secret is cleared. The mobile
 * process is long-lived (no MV3 service-worker kill), so this deliberate,
 * bounded exposure window IS the security guarantee — we do NOT rely on process
 * termination to clear keys.
 *
 * Clearing the `KeyVault` alone is INSUFFICIENT: the `KeyringManager` also holds
 * the unlocked `{mnemonic, password}` in `this.unlocked`. So the auto-lock calls
 * `manager.lock()`, which clears BOTH the manager's secret AND the KeyVault
 * (mirroring the extension's idle-lock fix where idle called `manager.lock()`,
 * not just `keyVault.lock()`).
 *
 * iOS BACKGROUND-SNAPSHOT PRIVACY: on resign-active iOS captures a snapshot of
 * the current screen for the app switcher, which could expose on-screen secrets
 * (balances, addresses, a revealed phrase). The actual native blur/overlay is a
 * native/config concern; here we expose an `onResignActive` hook the app entry
 * (T8.6) can use to render a privacy overlay synchronously on background, and a
 * mirror `onForeground` hook that LOWERS that overlay on resume so the app is
 * never left permanently blank after a background cycle. Resume lowers the
 * overlay ONLY — it never auto-unlocks the vault.
 */

/**
 * The slice of the `@capacitor/app` plugin this module consumes. Narrowed to the
 * lifecycle `addListener` overloads we subscribe to so the plugin can be injected
 * (and faked) at the boundary in tests.
 */
export interface AppLifecycle {
  addListener(
    eventName: 'appStateChange',
    listenerFunc: (state: { isActive: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: 'pause',
    listenerFunc: () => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/** The minimal lock surface the auto-lock drives — clears manager + KeyVault. */
export interface Lockable {
  lock(): Promise<void>;
}

export interface AutoLockDeps {
  /** The `@capacitor/app` plugin (injected so tests can fake the lifecycle). */
  readonly app: AppLifecycle;
  /**
   * The owning `KeyringManager`. `manager.lock()` clears BOTH the manager's
   * in-memory `{mnemonic, password}` and the wired KeyVault — clearing the
   * KeyVault alone would leave the manager's secret resident.
   */
  readonly manager: Lockable;
  /**
   * Optional iOS-snapshot privacy hook, invoked synchronously on resign-active
   * BEFORE the (async) lock resolves, so the app entry can drop a privacy
   * overlay before the app-switcher snapshot is taken.
   */
  readonly onResignActive?: () => void;
  /**
   * Optional foreground hook, invoked when the app returns to active. The mirror
   * of `onResignActive`: it LOWERS the privacy overlay raised on background so
   * the app is not left permanently blank after one background cycle. It does
   * NOT unlock — resume keeps the vault locked; the user re-authenticates.
   */
  readonly onForeground?: () => void;
}

/** A started auto-lock; `stop()` removes the lifecycle subscriptions. */
export interface AutoLockHandle {
  stop(): Promise<void>;
}

/**
 * Subscribe to the app lifecycle and clear the full wallet secret on background.
 *
 * Listens on both `appStateChange` (fired with `isActive:false` on
 * background/resign) and `pause` (iOS `didEnterBackground` / Android `onPause`)
 * so the lock fires on every backgrounding path. A foreground transition
 * (`appStateChange` `isActive:true`) does NOT unlock — it only LOWERS the
 * privacy overlay raised on background so the app is not left permanently blank.
 */
export async function startAutoLock(deps: AutoLockDeps): Promise<AutoLockHandle> {
  const { app, manager, onResignActive, onForeground } = deps;

  const onBackground = (): void => {
    // Privacy overlay first (synchronous) so it is up before the lock awaits and
    // before the OS snapshots the screen for the app switcher.
    onResignActive?.();
    // Clear the FULL secret: manager.lock() drops {mnemonic, password} AND locks
    // the KeyVault. Fire-and-forget — lifecycle callbacks are not awaited by the
    // plugin, but the clear is synchronous in practice and idempotent.
    void manager.lock();
  };

  const stateHandle = await app.addListener('appStateChange', (state) => {
    if (state.isActive) {
      // Returning to foreground: lower the overlay so the app renders again. The
      // vault stays locked — resume does NOT auto-unlock.
      onForeground?.();
    } else {
      onBackground();
    }
  });
  const pauseHandle = await app.addListener('pause', () => {
    onBackground();
  });

  return {
    async stop(): Promise<void> {
      await stateHandle.remove();
      await pauseHandle.remove();
    },
  };
}
