/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Vencord port of WPMTracker for BetterDiscord by astricxzs (OkAlexJ)
 * https://github.com/OkAlexJ/WPMTracker
 */

/*
 * How it works
 * ------------
 * Discord never sends other people's keystrokes, only a TYPING_START event when they
 * begin typing (re-sent roughly every 10s while they keep going). So for other users:
 *
 *     time ≈ first TYPING_START of the burst → message arrives
 *     WPM  ≈ (characters / 5) / time
 *
 * For yourself the plugin sees real keystrokes, so it knows two times:
 *     typing time = time actually spent typing (pauses longer than 2s are capped)
 *     total time  = first keystroke → message sent
 *
 * Results that are implausibly fast (pasted text, drafts typed elsewhere) are discarded.
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { SelectedChannelStore, UserStore,useState } from "@webpack/common";

import managedStyle from "./style.css?managed";

type BadgeMode = "wpm" | "time" | "both";

interface Session {
    start: number;
    last: number;
    active: number;
    keys: number;
    pasted: boolean;
}

interface Badge {
    wpm: number;
    typingMs: number;
    totalMs: number;
    chars: number;
    self: boolean;
}

interface UserStats {
    name: string;
    username: string;
    samples: number;
    sum: number;
    sumMs: number;
    best: number;
    last: number;
    lastAt: number;
    history: number[];
}

interface Author {
    id: string;
    username?: string;
    globalName?: string;
    global_name?: string;
    bot?: boolean;
}

const BADGE_MODES: BadgeMode[] = ["wpm", "time", "both"];
const TYPING_GAP_MS = 15000; // a typing burst ends if no TYPING_START arrives for this long
const SELF_IDLE_CAP_MS = 2000; // longest pause between your own keystrokes that counts as typing
const SESSION_TTL_MS = 120000; // drop sessions that never turned into a message
const LIVE_HIDE_MS = 3000; // hide the live counter after this long without a keystroke
const HISTORY_LEN = 50;
const BADGE_CACHE = 2000;
const BADGE_PERSIST = 500; // badges kept across restarts

const STATS_KEY = "WPMTracker_stats";
const BADGES_KEY = "WPMTracker_badges";

const settings = definePluginSettings({
    showBadges: {
        type: OptionType.BOOLEAN,
        description: "Show a typing speed badge after messages",
        default: true,
        onChange: () => refreshBadges()
    },
    badgeMode: {
        type: OptionType.SELECT,
        description: "What the badge shows (click a badge in chat to cycle)",
        options: [
            { label: "WPM + seconds", value: "both", default: true },
            { label: "WPM only", value: "wpm" },
            { label: "Seconds only", value: "time" }
        ],
        onChange: () => refreshBadges()
    },
    timeSource: {
        type: OptionType.SELECT,
        description: "What the seconds measure (only differs for your own messages)",
        options: [
            { label: "Time spent typing", value: "typing", default: true },
            { label: "Total time until sent", value: "total" }
        ],
        onChange: () => refreshBadges()
    },
    colorBadges: {
        type: OptionType.BOOLEAN,
        description: "Color badges by speed",
        default: true,
        onChange: () => refreshBadges()
    },
    showLive: {
        type: OptionType.BOOLEAN,
        description: "Show a live WPM / timer above the chat box while you type",
        default: true,
        onChange: (on: boolean) => { if (!on) hideLive(); }
    },
    trackSelf: {
        type: OptionType.BOOLEAN,
        description: "Track your own typing speed",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore bots",
        default: true
    },
    wordMode: {
        type: OptionType.SELECT,
        description: "How words are counted",
        options: [
            { label: "Standard (5 characters = 1 word)", value: "standard", default: true },
            { label: "Actual words", value: "words" }
        ]
    },
    minSeconds: {
        type: OptionType.NUMBER,
        description: "Ignore messages typed faster than this many seconds",
        default: 1.5
    },
    maxWpm: {
        type: OptionType.NUMBER,
        description: "Discard results above this WPM (likely pasted)",
        default: 250
    }
});

const sessions = new Map<string, Session>(); // `${channelId}:${userId}`
const badges = new Map<string, Badge>(); // messageId or nonce
let stats: Record<string, UserStats> = {};

let started = false;
let observer: MutationObserver | null = null;
let badgeFrame: number | null = null;
let purgeTimer: ReturnType<typeof setInterval> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let liveEl: HTMLDivElement | null = null;

function formatTime(ms: number) {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

const speedClass = (wpm: number) =>
    wpm >= 100 ? "vc-wpmt-blazing" : wpm >= 70 ? "vc-wpmt-fast" : wpm >= 40 ? "vc-wpmt-ok" : "vc-wpmt-slow";

const selfId = () => UserStore.getCurrentUser()?.id;

function selfKey() {
    const channelId = SelectedChannelStore.getChannelId();
    const userId = selfId();
    return channelId && userId ? `${channelId}:${userId}` : null;
}

function countWords(text: string) {
    return settings.store.wordMode === "words" ? (text.match(/\S+/g)?.length ?? 0) : text.length / 5;
}

const displayName = (author: Author) => author.globalName ?? author.global_name ?? author.username ?? author.id;

// Yourself: count real keystrokes in the message box.
function onKeyDown(e: KeyboardEvent) {
    if (!settings.store.trackSelf) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" && !e.shiftKey) return; // that's the send, handled by MESSAGE_CREATE
    if (e.key.length !== 1 && e.key !== "Backspace" && e.key !== "Enter") return;
    const textbox = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[role="textbox"]');
    if (!textbox) return;

    const key = selfKey();
    if (!key) return;

    const now = Date.now();
    let s = sessions.get(key);
    if (!s) {
        s = { start: now, last: now, active: 0, keys: 0, pasted: false };
        sessions.set(key, s);
    } else {
        s.active += Math.min(now - s.last, SELF_IDLE_CAP_MS);
        s.last = now;
    }
    if (e.key.length === 1) s.keys++;

    // Read the box after the keystroke has landed.
    if (settings.store.showLive) {
        const session = s;
        setTimeout(() => updateLive(textbox, session), 0);
    }
}

function onPaste(e: ClipboardEvent) {
    if (!settings.store.trackSelf || !(e.target as HTMLElement | null)?.closest?.('[role="textbox"]')) return;
    const key = selfKey();
    if (!key) return;
    const s = sessions.get(key);
    if (s) s.pasted = true;
    else sessions.set(key, { start: Date.now(), last: Date.now(), active: 0, keys: 0, pasted: true });
}

function updateLive(textbox: HTMLElement, s: Session) {
    if (!started || !textbox.isConnected) return hideLive();
    const text = textbox.textContent?.trim();
    if (!text) return hideLive();

    if (!liveEl) {
        liveEl = document.createElement("div");
        liveEl.className = "vc-wpmt-live";
        document.body.appendChild(liveEl);
    }
    const ms = Math.max(s.active, 1);
    const wpm = Math.round(countWords(text) / (ms / 60000));
    const parts: string[] = [];
    if (s.pasted) parts.push("pasted");
    else if (ms >= 1000 && wpm <= settings.store.maxWpm) parts.push(`${wpm} WPM`);
    else parts.push("— WPM");
    parts.push(formatTime(settings.store.timeSource === "total" ? Date.now() - s.start : s.active));
    liveEl.textContent = parts.join(" · ");

    const rect = (textbox.closest("form") ?? textbox).getBoundingClientRect();
    liveEl.style.top = `${Math.max(rect.top - 28, 4)}px`;
    liveEl.style.right = `${Math.max(window.innerWidth - rect.right + 12, 4)}px`;
    liveEl.style.opacity = "1";

    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => hideLive(), LIVE_HIDE_MS);
}

function hideLive(remove = false) {
    clearTimeout(liveTimer);
    if (!liveEl) return;
    if (remove) {
        liveEl.remove();
        liveEl = null;
    } else {
        liveEl.style.opacity = "0";
    }
}

function record(author: Author, wpm: number, ms: number) {
    const st = stats[author.id] ??= {
        name: "", username: "", samples: 0, sum: 0, sumMs: 0, best: 0, last: 0, lastAt: 0, history: []
    };
    st.name = displayName(author);
    st.username = author.username ?? "";
    st.samples++;
    st.sum += wpm;
    st.sumMs += ms;
    st.best = Math.max(st.best, wpm);
    st.last = wpm;
    st.lastAt = Date.now();
    st.history.push(Math.round(wpm));
    if (st.history.length > HISTORY_LEN) st.history.shift();
    saveSoon();
}

function setBadge(id: string, badge: Badge) {
    badges.set(id, badge);
    if (badges.size > BADGE_CACHE) badges.delete(badges.keys().next().value!);
}

function badgeText(b: Badge) {
    const ms = settings.store.timeSource === "total" ? b.totalMs : b.typingMs;
    const time = formatTime(ms);
    switch (settings.store.badgeMode as BadgeMode) {
        case "time": return time;
        case "wpm": return `${b.wpm} WPM`;
        default: return `${b.wpm} WPM · ${time}`;
    }
}

function badgeTitle(b: Badge) {
    const lines = [`${b.wpm} WPM`];
    if (b.self) lines.push(`Typing time: ${formatTime(b.typingMs)}`, `Total time to send: ${formatTime(b.totalMs)}`);
    else lines.push(`Time to send: ${formatTime(b.totalMs)} (estimated from typing indicator)`);
    lines.push(`${b.chars} characters`, "", "Click to switch: WPM / seconds / both");
    return lines.join("\n");
}

function onBadgeClick(e: MouseEvent) {
    if (!(e.target as HTMLElement | null)?.classList?.contains("vc-wpmt-badge")) return;
    e.preventDefault();
    e.stopPropagation();
    const i = BADGE_MODES.indexOf(settings.store.badgeMode as BadgeMode);
    settings.store.badgeMode = BADGE_MODES[(i + 1) % BADGE_MODES.length];
    refreshBadges();
}

function purgeSessions() {
    const now = Date.now();
    for (const [key, s] of sessions) if (now - s.last > SESSION_TTL_MS) sessions.delete(key);
}

function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 2000);
}

function flushSave() {
    clearTimeout(saveTimer);
    DataStore.set(STATS_KEY, stats);
    // Only real message ids (snowflakes) are worth keeping; nonces are temporary.
    const entries = [...badges].filter(([id]) => /^\d{17,20}$/.test(id));
    DataStore.set(BADGES_KEY, Object.fromEntries(entries.slice(-BADGE_PERSIST)));
}

function scheduleBadges() {
    if (badgeFrame != null || !started || !settings.store.showBadges || !badges.size) return;
    badgeFrame = requestAnimationFrame(() => {
        badgeFrame = null;
        renderBadges();
    });
}

function removeBadges() {
    document.querySelectorAll(".vc-wpmt-badge").forEach(el => el.remove());
}

function refreshBadges() {
    removeBadges();
    scheduleBadges();
}

function renderBadges() {
    for (const el of document.querySelectorAll<HTMLElement>('[id^="message-content-"]')) {
        if (el.querySelector(".vc-wpmt-badge") || el.closest('[id^="message-reply-context"]')) continue;
        const b = badges.get(el.id.slice("message-content-".length));
        if (!b) continue;
        const badge = document.createElement("span");
        badge.className = "vc-wpmt-badge";
        if (settings.store.colorBadges) badge.classList.add(speedClass(b.wpm));
        badge.textContent = badgeText(b);
        badge.title = badgeTitle(b);
        el.appendChild(badge);
    }
}

type SortKey = "name" | "avg" | "best" | "last" | "avgMs" | "samples";

const COLUMNS: [SortKey, string][] = [
    ["name", "User"], ["avg", "Avg"], ["best", "Best"], ["last", "Last"], ["avgMs", "Avg time"], ["samples", "Msgs"]
];

function StatsTable() {
    const [query, setQuery] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("avg");
    const [, setVersion] = useState(0);

    const q = query.trim().toLowerCase();
    const rows = Object.entries(stats)
        .map(([id, st]) => ({ id, ...st, avg: st.sum / st.samples, avgMs: st.samples ? st.sumMs / st.samples : -1 }))
        .filter(r => !q || r.name?.toLowerCase().includes(q) || r.username?.toLowerCase().includes(q))
        .sort((a, b) => sortKey === "name" ? (a.name ?? "").localeCompare(b.name ?? "") : b[sortKey] - a[sortKey]);

    const reset = () => {
        if (!confirm("Delete all recorded typing speeds?")) return;
        stats = {};
        badges.clear();
        flushSave();
        removeBadges();
        setVersion(v => v + 1);
    };

    return (
        <div className="vc-wpmt-stats">
            <input
                className="vc-wpmt-search"
                placeholder="Search users…"
                value={query}
                onChange={e => setQuery(e.currentTarget.value)}
            />
            {rows.length ? (
                <table className="vc-wpmt-table">
                    <thead>
                        <tr>
                            {COLUMNS.map(([key, label]) => (
                                <th key={key} className={key === "name" ? "" : "vc-wpmt-num"} onClick={() => setSortKey(key)}>
                                    {label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={r.id}>
                                <td title={r.username ? `@${r.username}` : r.id}>{r.name || r.id}</td>
                                <td className="vc-wpmt-num">{Math.round(r.avg)}</td>
                                <td className="vc-wpmt-num">{Math.round(r.best)}</td>
                                <td className="vc-wpmt-num">{Math.round(r.last)}</td>
                                <td className="vc-wpmt-num">{r.avgMs >= 0 ? formatTime(r.avgMs) : "—"}</td>
                                <td className="vc-wpmt-num">{r.samples}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <div className="vc-wpmt-empty">
                    No data yet. Stats appear once people type and send messages while the plugin is running.
                </div>
            )}
            <button className="vc-wpmt-reset" onClick={reset}>Reset all stats</button>
        </div>
    );
}

export default definePlugin({
    name: "WPMTracker",
    description: "Estimates how fast people typed (WPM and seconds) from Discord's typing indicator and shows it as a badge after each message",
    authors: [{ name: "astricxzs", id: 0n }],
    settings,
    managedStyle,

    settingsAboutComponent: StatsTable,

    flux: {
        // Other users: Discord tells us when they start typing.
        TYPING_START({ channelId, userId }: { channelId: string; userId: string; }) {
            if (!channelId || !userId || userId === selfId()) return; // self is measured from keystrokes
            if (settings.store.ignoreBots && UserStore.getUser(userId)?.bot) return;

            const key = `${channelId}:${userId}`;
            const now = Date.now();
            let s = sessions.get(key);
            if (!s || now - s.last > TYPING_GAP_MS) s = { start: now, last: now, active: 0, keys: 0, pasted: false };
            s.last = now;
            sessions.set(key, s);
        },

        MESSAGE_CREATE({ channelId, message }: { channelId: string; message: { id: string; nonce?: string; content?: string; author?: Author; }; }) {
            const author = message?.author;
            if (!author || !channelId) return;

            const key = `${channelId}:${author.id}`;
            const s = sessions.get(key);
            if (!s) {
                // Server echo of our own optimistic message: carry the badge over to the real id.
                const fromNonce = message.nonce && badges.get(message.nonce);
                if (fromNonce) {
                    setBadge(message.id, fromNonce);
                    saveSoon();
                    scheduleBadges();
                }
                return;
            }
            sessions.delete(key);

            const isSelf = author.id === selfId();
            if (isSelf) hideLive();
            const now = Date.now();
            if (!isSelf && now - s.last > TYPING_GAP_MS) return; // they sat on a draft; timing is meaningless

            const content = (message.content ?? "")
                .replace(/<a?:\w+:\d+>/g, ":e:") // custom emoji
                .replace(/<[@#][!&]?\d+>/g, "@user") // mentions
                .replace(/<t:\d+(:\w)?>/g, "time") // timestamps
                .trim();
            if (!content) return;

            // Pasted, or far more text than keys pressed (autocomplete, drafts restored).
            if (isSelf && (s.pasted || content.length > s.keys * 1.3 + 10)) return;

            const totalMs = now - s.start;
            const typingMs = isSelf ? s.active + Math.min(now - s.last, SELF_IDLE_CAP_MS) : totalMs;
            if (typingMs < settings.store.minSeconds * 1000) return;

            const wpm = countWords(content) / (typingMs / 60000);
            if (!Number.isFinite(wpm) || wpm > settings.store.maxWpm) return; // probably pasted

            record(author, wpm, typingMs);

            const badge: Badge = { wpm: Math.round(wpm), typingMs, totalMs, chars: content.length, self: isSelf };
            setBadge(message.id, badge);
            if (message.nonce) setBadge(message.nonce, badge);
            scheduleBadges();
        }
    },

    async start() {
        started = true;
        stats = await DataStore.get(STATS_KEY) ?? {};
        for (const [id, b] of Object.entries(await DataStore.get<Record<string, Badge>>(BADGES_KEY) ?? {})) {
            if (!badges.has(id)) badges.set(id, b);
        }

        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("paste", onPaste, true);
        document.addEventListener("click", onBadgeClick, true);
        purgeTimer = setInterval(purgeSessions, 30000);

        // Re-attach badges whenever Discord re-renders the chat.
        observer = new MutationObserver(scheduleBadges);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleBadges();
    },

    stop() {
        started = false;
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("paste", onPaste, true);
        document.removeEventListener("click", onBadgeClick, true);
        clearInterval(purgeTimer);
        observer?.disconnect();
        observer = null;
        if (badgeFrame != null) cancelAnimationFrame(badgeFrame);
        badgeFrame = null;
        hideLive(true);
        flushSave();
        removeBadges();
        sessions.clear();
        badges.clear();
    }
});
