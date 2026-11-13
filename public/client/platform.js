// Game portals. On lineclash.com this is all no-ops. On CrazyGames (the page was
// opened through the CrazyGames loader: <meta name="platform" content="crazygames">)
// it talks to their SDK: loading/gameplay events, video ads between matches,
// invite links for friends' rooms, their username and their mute setting.
// Every SDK call is wrapped: a failing SDK must never break the game.

const PLATFORM = document.querySelector('meta[name="platform"]')?.content || 'web';

let sdk = null;          // window.CrazyGames.SDK once init worked
let playing = false;     // last gameplayStart/Stop we sent
let settingsCb = null;

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

export const platform = {
  name: PLATFORM,
  /** True on CrazyGames: no Google sign-in, no AdSense, invite links through the SDK. */
  get crazy() { return PLATFORM === 'crazygames'; },
  get ready() { return !!sdk; },

  /** Starts the SDK (max ~4 s, so a slow SDK can't block the game). */
  async init() {
    if (PLATFORM !== 'crazygames') return;
    const S = window.CrazyGames?.SDK;
    if (!S) return;
    try {
      await Promise.race([S.init(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
      if (S.environment === 'disabled') return;
      sdk = S;
      safe(() => sdk.game.addSettingsChangeListener((s) => settingsCb?.(s)));
    } catch {}
  },

  loading(on) {
    if (sdk) safe(() => (on ? sdk.game.loadingStart() : sdk.game.loadingStop()));
  },

  /** Call as often as you like: only changes are sent. */
  gameplay(on) {
    if (!sdk || on === playing) return;
    playing = on;
    safe(() => (on ? sdk.game.gameplayStart() : sdk.game.gameplayStop()));
  },

  happytime() {
    if (sdk) safe(() => sdk.game.happytime());
  },

  /** The portal wants all game audio off (its own mute button). */
  get muted() { return !!(sdk && safe(() => sdk.game.settings.muteAudio, false)); },
  onSettings(cb) { settingsCb = cb; },

  /**
   * A video ad between matches. The SDK decides if one is due (at most one every
   * few minutes), so this often finishes right away. Resolves when the game may go on.
   */
  midgameAd({ started, done } = {}) {
    return new Promise((resolve) => {
      if (!sdk) { resolve(); return; }
      let over = false;
      const end = () => { if (over) return; over = true; done?.(); resolve(); };
      try {
        sdk.ad.requestAd('midgame', { adStarted: () => started?.(), adFinished: end, adError: end });
      } catch { end(); }
    });
  },

  /** The portal player's name, or '' (not logged in / no portal). */
  async username() {
    if (!sdk || !safe(() => sdk.user.isUserAccountAvailable, false)) return '';
    try { return (await sdk.user.getUser())?.username || ''; } catch { return ''; }
  },

  // ---- friends' rooms
  /** Room code from the invite link this game was opened with. */
  inviteRoom() {
    if (!sdk) return null;
    return safe(() => sdk.game.getInviteParam('room'), null) || safe(() => sdk.game.inviteParams?.room, null) || null;
  },
  /** Start straight in a friends' room (the player clicked "play with friends" on the portal). */
  get instantMultiplayer() { return !!(sdk && safe(() => sdk.game.isInstantMultiplayer, false)); },
  async inviteLink(code) {
    if (!sdk) return null;
    try { return (await sdk.game.inviteLink({ room: code })) || null; } catch { return null; }
  },
  room(code) {
    if (!sdk) return;
    safe(() => (code ? sdk.game.updateRoom({ roomId: code, isJoinable: true, inviteParams: { room: code } }) : sdk.game.leftRoom()));
  },
  /** A friend's invite was clicked while the game was already open. */
  onJoinRoom(cb) {
    if (sdk) safe(() => sdk.game.addJoinRoomListener((p) => { if (p && p.room) cb(String(p.room)); }));
  },
};
