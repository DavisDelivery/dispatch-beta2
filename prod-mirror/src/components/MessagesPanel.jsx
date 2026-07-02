// src/components/MessagesPanel.jsx
//
// Messages — a full texting client for the dispatch board, modeled on the iOS
// Messages app. Three stacked views inside one window (mobile: full-screen; desktop:
// right-side drawer over the map):
//
//   1. Conversations  — avatar + name + last-message preview + time + unread dot,
//                        searchable, with a compose button to start a new text.
//   2. New message    — a contact picker grouped into Drivers / Contractors /
//                        Customers / Team (the roster the dispatcher asked for),
//                        plus "Recent" and a "send to a typed number" affordance.
//   3. Conversation   — iMessage-style bubbles with grouped time separators and a
//                        pill composer; outbound sends echo instantly (optimistic).
//
// Contacts come from two sources, merged by phone:
//   • Employees (drivers / contractors / team) — /.netlify/functions/messaging-roster
//   • Customers — derived from customer_notes on the client, passed in as a prop.
//
// Sending reuses /.netlify/functions/send-sms (the browser can't hold the SMS key).
// Inbound replies + recorded outbounds stream in via the `messages` prop (a live
// Firestore subscription owned by the shell).

import { useState, useRef, useEffect, useMemo } from 'react';
import { MessageSquare, X, Send, ArrowLeft, Search, SquarePen, Phone, AlertCircle, ChevronRight } from 'lucide-react';

const BRAND = '#1e5b92';

// ---------- phone + name helpers ----------

const digits = (p) => String(p ?? '').replace(/\D/g, '');
const normPhone = (p) => { const d = digits(p); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
const isPhone10 = (p) => normPhone(p).length === 10;
function fmtPhone(raw) {
  const ten = normPhone(raw);
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : (raw || '');
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Deterministic avatar color from a key (name or phone) — iMessage-style colored
// circles so contacts are visually distinct at a glance.
const AVATAR_COLORS = ['#1e5b92', '#0a7ea4', '#2563eb', '#7c3aed', '#db2777', '#e11d48', '#ea580c', '#16a34a', '#0891b2', '#9333ea'];
function avatarColor(key) {
  const s = String(key || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Relative age for the conversation list ("2m", "3h", "Tue").
function fmtAgoShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (!Number.isFinite(secs)) return '';
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  if (secs < 7 * 86400) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

// Centered separator label inside a thread ("Today 2:34 PM", "Mon 9:10 AM").
function fmtSeparator(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today ${t}`;
  const within7 = (now - d) < 7 * 86400 * 1000;
  if (within7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

async function postSendSms(payload) {
  const r = await fetch('/.netlify/functions/send-sms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return r.json();
}

// Employee roster (drivers / contractors / team) for the contact picker.
function useMessagingRoster() {
  const [contacts, setContacts] = useState([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/.netlify/functions/messaging-roster');
        const d = await r.json();
        if (!cancelled && d?.ok && Array.isArray(d.contacts)) setContacts(d.contacts);
      } catch { /* best-effort: customers + threads still work */ }
      finally { if (!cancelled) setReady(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  return { contacts, ready };
}

// Track the VISIBLE viewport (height + top offset). On mobile the panel is
// position:fixed, which iOS sizes to the *layout* viewport — so when the soft
// keyboard opens, a bottom-pinned composer ends up hidden BEHIND the keyboard
// ("no way to send"). Sizing the panel to window.visualViewport keeps the
// composer and Send button above the keyboard, like the rest of the app does.
function useVisualViewport() {
  const read = () => {
    if (typeof window === 'undefined') return { h: 0, top: 0 };
    const vv = window.visualViewport;
    return { h: vv ? vv.height : window.innerHeight, top: vv ? vv.offsetTop : 0 };
  };
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setVp(read());
    update();
    if (vv) { vv.addEventListener('resize', update); vv.addEventListener('scroll', update); }
    window.addEventListener('resize', update);
    return () => {
      if (vv) { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); }
      window.removeEventListener('resize', update);
    };
  }, []);
  return vp;
}

// ---------- small presentational bits ----------

const GROUP_META = {
  driver: { chip: 'Driver', chipCls: 'bg-blue-100 text-blue-700' },
  contractor: { chip: 'Contractor', chipCls: 'bg-violet-100 text-violet-700' },
  customer: { chip: 'Customer', chipCls: 'bg-emerald-100 text-emerald-700' },
  team: { chip: 'Team', chipCls: 'bg-slate-100 text-slate-600' },
};

function Avatar({ name, phone, size = 44 }) {
  const key = name || phone || '?';
  const text = initials(name);
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0 select-none"
      style={{ width: size, height: size, background: avatarColor(key), fontSize: size * 0.36 }}
    >
      {text || <Phone size={size * 0.42} />}
    </div>
  );
}

function GroupChip({ group }) {
  const m = GROUP_META[group];
  if (!m) return null;
  return <span className={`text-[9px] uppercase tracking-wide font-bold rounded px-1.5 py-0.5 ${m.chipCls}`}>{m.chip}</span>;
}

// ---------- main component ----------

export default function MessagesPanel({ messages, seenAt = 0, onClose, customerContacts = [] }) {
  const { contacts: roster } = useMessagingRoster();
  const vp = useVisualViewport();

  const [view, setView] = useState('list');          // 'list' | 'new' | 'thread'
  const [active, setActive] = useState(null);        // { phone, name, group, isEmployee }
  const [listQuery, setListQuery] = useState('');
  const [newQuery, setNewQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState([]);        // optimistic outbound echoes
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const newSearchRef = useRef(null);

  // Merge every known contact into one phone-keyed directory. Employee roster
  // entries win over customer entries for name/group (a person who is a driver
  // shouldn't be mislabeled "Customer" just because they're also on a notes card).
  const directory = useMemo(() => {
    const byPhone = new Map();
    const upsert = (phone, name, group, isEmployee) => {
      const k = normPhone(phone);
      if (k.length !== 10) return;
      const cur = byPhone.get(k) || { phone: k, name: '', group: null, isEmployee: false };
      if (isEmployee) { cur.isEmployee = true; cur.group = group; if (name) cur.name = name; }
      else { if (!cur.isEmployee) cur.group = cur.group || 'customer'; if (name && !cur.name) cur.name = name; }
      byPhone.set(k, cur);
    };
    for (const c of roster) upsert(c.phone, c.name, c.group || 'team', true);
    for (const c of customerContacts) upsert(c.phone, c.name, 'customer', false);
    return byPhone;
  }, [roster, customerContacts]);

  const resolveContact = (phone, driverTag) => {
    const k = normPhone(phone);
    const d = directory.get(k);
    if (d) return { phone: k, name: d.name || driverTag || null, group: d.group || (driverTag ? 'driver' : 'customer'), isEmployee: d.isEmployee || !!driverTag };
    if (driverTag) return { phone: k, name: driverTag, group: 'driver', isEmployee: true };
    return { phone: k, name: null, group: 'customer', isEmployee: false };
  };

  // Group the live message stream into conversation threads by the other party's
  // phone, enriched with the resolved contact + unread flag, newest first.
  const threads = useMemo(() => {
    const byPhone = new Map();
    for (const m of messages || []) {
      const k = normPhone(m.contactPhone);
      if (k.length !== 10) continue;
      let t = byPhone.get(k);
      if (!t) { t = { phone: k, msgs: [], driverTag: null }; byPhone.set(k, t); }
      t.msgs.push(m);
      if (m.driverName && !t.driverTag) t.driverTag = m.driverName;
    }
    const arr = [...byPhone.values()].map((t) => {
      t.msgs.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
      const last = t.msgs[t.msgs.length - 1];
      const c = resolveContact(t.phone, t.driverTag);
      const unread = t.msgs.some((m) => m.direction === 'in' && new Date(m.at || 0).getTime() > seenAt);
      return { ...t, ...c, last, lastAt: last?.at || null, unread };
    });
    arr.sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, directory, seenAt]);

  // Drop optimistic echoes once the real recorded outbound shows up in the stream.
  useEffect(() => {
    if (!pending.length) return;
    setPending((p) => p.filter((pm) => !(messages || []).some(
      (m) => m.direction === 'out' && normPhone(m.contactPhone) === pm.phone && (m.text || '').trim() === pm.text.trim(),
    )));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Focus + autoscroll behavior per view.
  useEffect(() => {
    if (view === 'thread') setTimeout(() => composerRef.current?.focus(), 60);
    if (view === 'new') setTimeout(() => newSearchRef.current?.focus(), 60);
  }, [view, active?.phone]);

  const activeThread = active ? threads.find((t) => t.phone === active.phone) : null;
  const threadMsgs = useMemo(() => {
    const real = activeThread ? activeThread.msgs : [];
    const echoes = active ? pending.filter((p) => p.phone === active.phone) : [];
    return [...real, ...echoes].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  }, [activeThread, pending, active]);

  useEffect(() => {
    if (view === 'thread' && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [threadMsgs.length, view]);

  const openConversation = (contact) => {
    setActive({ phone: normPhone(contact.phone), name: contact.name || null, group: contact.group || 'customer', isEmployee: !!contact.isEmployee });
    setDraft('');
    setView('thread');
  };

  const titleOf = (c) => c?.name || fmtPhone(c?.phone);

  const sendInThread = async (retryText) => {
    const text = (retryText ?? draft).trim();
    if (!text || !active) return;
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setPending((p) => [...p.filter((m) => !(m.status === 'failed' && m.text.trim() === text && m.phone === active.phone)),
      { tempId, phone: active.phone, text, at: new Date().toISOString(), direction: 'out', status: 'sending' }]);
    if (retryText == null) setDraft('');
    setSending(true);
    try {
      const recipients = [{ to: active.phone, label: titleOf(active), ...(active.isEmployee && active.name ? { driverName: active.name } : {}) }];
      const res = await postSendSms({ text, recipients });
      const ok = res?.ok || res?.sent > 0;
      if (ok) {
        // Leave the echo; the snapshot effect swaps in the recorded message. Fallback
        // cleanup in case Firestore lags or is disabled in this environment.
        setTimeout(() => setPending((p) => p.filter((m) => m.tempId !== tempId)), 8000);
      } else {
        const err = res?.results?.find((r) => !r.ok)?.error || res?.error || 'Not delivered';
        setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: 'failed', error: err } : m)));
      }
    } catch (e) {
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, status: 'failed', error: e.message } : m)));
    } finally { setSending(false); }
  };

  // ----- conversation list (filtered) -----
  const filteredThreads = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    if (!q) return threads;
    const qd = q.replace(/\D/g, '');
    return threads.filter((t) => (t.name || '').toLowerCase().includes(q) || (qd && t.phone.includes(qd)) || (t.last?.text || '').toLowerCase().includes(q));
  }, [threads, listQuery]);

  // ----- contact picker sections (New message) -----
  const sections = useMemo(() => {
    const q = newQuery.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    const match = (c) => !q || (c.name || '').toLowerCase().includes(q) || (qd && c.phone.includes(qd));
    const byName = (a, b) => {
      if (!!a.name !== !!b.name) return a.name ? -1 : 1;       // named before number-only
      return (a.name || a.phone).localeCompare(b.name || b.phone);
    };
    const all = [...directory.values()].filter(match);
    const pick = (g) => all.filter((c) => (c.group || 'customer') === g).sort(byName);
    const recent = threads.filter((t) => match(t)).slice(0, 8);
    return { recent, drivers: pick('driver'), contractors: pick('contractor'), customers: pick('customer'), team: pick('team') };
  }, [directory, threads, newQuery]);

  const typedNumber = useMemo(() => {
    const k = normPhone(newQuery);
    if (k.length !== 10 || directory.has(k)) return null;
    return k;
  }, [newQuery, directory]);

  const totalUnread = threads.filter((t) => t.unread).length;

  // ---------- render ----------

  const Header = (
    <div
      className="px-3 py-2.5 border-b flex items-center gap-2 flex-shrink-0 text-white"
      style={{ background: BRAND, paddingTop: 'max(0.625rem, env(safe-area-inset-top))' }}
    >
      {view === 'list' ? (
        <>
          <MessageSquare size={18} className="flex-shrink-0" />
          <div className="font-semibold flex-1 truncate">Messages</div>
          <button onClick={() => { setNewQuery(''); setView('new'); }} className="p-1.5 -mr-0.5 rounded-full hover:bg-white/15" aria-label="New message" title="New message">
            <SquarePen size={19} />
          </button>
        </>
      ) : view === 'new' ? (
        <>
          <button onClick={() => setView('list')} className="p-1 -ml-1 rounded-full hover:bg-white/15 flex-shrink-0" aria-label="Back"><ArrowLeft size={18} /></button>
          <div className="font-semibold flex-1 truncate">New Message</div>
        </>
      ) : (
        <>
          <button onClick={() => setView('list')} className="p-1 -ml-1 rounded-full hover:bg-white/15 flex-shrink-0" aria-label="Back to messages"><ArrowLeft size={18} /></button>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Avatar name={active?.name} phone={active?.phone} size={28} />
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate leading-tight">{titleOf(active)}</div>
              <div className="text-[10px] text-white/70 truncate leading-tight">
                {active?.name ? fmtPhone(active.phone) : (GROUP_META[active?.group]?.chip || '')}
                {active?.group && active?.name ? ` · ${GROUP_META[active.group]?.chip}` : ''}
              </div>
            </div>
          </div>
        </>
      )}
      <button onClick={onClose} className="p-1.5 -mr-0.5 rounded-full hover:bg-white/15 flex-shrink-0" aria-label="Close messages"><X size={18} /></button>
    </div>
  );

  return (
    // Pinned to the VISIBLE viewport (height + top offset) so the bottom composer
    // stays above the iOS keyboard instead of being hidden behind it.
    <div
      className="fixed inset-x-0 z-[1200] sm:bg-slate-900/40 flex justify-end overflow-hidden"
      style={{ top: vp.top || 0, height: vp.h ? vp.h : '100%' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full sm:max-w-[400px] bg-white h-full shadow-2xl flex flex-col min-h-0">
        {Header}

        {/* ---------- LIST ---------- */}
        {view === 'list' && (
          <>
            <div className="px-3 py-2 border-b flex-shrink-0">
              <div className="relative">
                <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={listQuery} onChange={(e) => setListQuery(e.target.value)}
                  placeholder="Search messages"
                  className="w-full bg-slate-100 rounded-full pl-8 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {filteredThreads.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-6 text-slate-400 gap-3">
                  <MessageSquare size={40} className="opacity-40" />
                  <div className="text-sm">{listQuery ? 'No matching conversations.' : 'No conversations yet.'}</div>
                  {!listQuery && (
                    <button onClick={() => { setNewQuery(''); setView('new'); }} className="inline-flex items-center gap-1.5 text-sm font-semibold text-white rounded-full px-4 py-2" style={{ background: BRAND }}>
                      <SquarePen size={15} /> New message
                    </button>
                  )}
                </div>
              ) : filteredThreads.map((t) => (
                <button key={t.phone} onClick={() => openConversation(t)} className="w-full text-left px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 flex items-center gap-3">
                  <div className="relative flex-shrink-0">
                    <Avatar name={t.name} phone={t.phone} size={44} />
                    {t.unread && <span className="absolute -top-0.5 -left-0.5 w-3 h-3 rounded-full bg-blue-500 border-2 border-white" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[15px] truncate ${t.unread ? 'font-bold text-slate-900' : 'font-semibold text-slate-800'}`}>{titleOf(t)}</span>
                      {t.group && t.group !== 'customer' && <GroupChip group={t.group} />}
                      <span className="ml-auto text-[11px] text-slate-400 flex-shrink-0 pl-1">{fmtAgoShort(t.lastAt)}</span>
                    </div>
                    <div className={`text-[13px] truncate ${t.unread ? 'text-slate-700' : 'text-slate-500'}`}>
                      {t.last?.direction === 'out' ? 'You: ' : ''}{t.last?.text || '—'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ---------- NEW MESSAGE ---------- */}
        {view === 'new' && (
          <>
            <div className="px-3 py-2 border-b flex-shrink-0 flex items-center gap-2">
              <span className="text-sm text-slate-500 font-medium">To:</span>
              <input
                ref={newSearchRef} value={newQuery} onChange={(e) => setNewQuery(e.target.value)}
                placeholder="Name or number"
                className="flex-1 text-sm focus:outline-none bg-transparent"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {typedNumber && (
                <ContactRow
                  contact={{ phone: typedNumber, name: null, group: 'customer', isEmployee: false }}
                  subtitle="Send to this number" onClick={openConversation} forceName={fmtPhone(typedNumber)}
                />
              )}
              <Section title="Recent" items={sections.recent} onPick={openConversation} keyer={(t) => `r_${t.phone}`} />
              <Section title="Drivers" items={sections.drivers} onPick={openConversation} keyer={(c) => `d_${c.phone}`} />
              <Section title="Contractors" items={sections.contractors} onPick={openConversation} keyer={(c) => `c_${c.phone}`} />
              <Section title="Customers" items={sections.customers} onPick={openConversation} keyer={(c) => `u_${c.phone}`} />
              <Section title="Team" items={sections.team} onPick={openConversation} keyer={(c) => `t_${c.phone}`} />
              {!typedNumber && !sections.recent.length && !sections.drivers.length && !sections.contractors.length && !sections.customers.length && !sections.team.length && (
                <div className="px-4 py-12 text-center text-sm text-slate-400">
                  {newQuery ? 'No matching contacts. Type a 10-digit number to text someone new.' : 'No contacts on the roster yet.'}
                </div>
              )}
            </div>
          </>
        )}

        {/* ---------- CONVERSATION ---------- */}
        {view === 'thread' && active && (
          <>
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 bg-slate-50">
              {threadMsgs.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 gap-2 px-6">
                  <Avatar name={active.name} phone={active.phone} size={56} />
                  <div className="text-sm font-medium text-slate-600">{titleOf(active)}</div>
                  <div className="text-xs">{fmtPhone(active.phone)}{active.group && active.group !== 'customer' ? ` · ${GROUP_META[active.group]?.chip}` : ''}</div>
                  <div className="text-xs">Send a message to start the conversation.</div>
                </div>
              )}
              {threadMsgs.map((m, i) => {
                const prev = threadMsgs[i - 1];
                const showSep = !prev || (new Date(m.at || 0) - new Date(prev.at || 0)) > 15 * 60 * 1000;
                const out = m.direction === 'out';
                const failed = m.status === 'failed';
                return (
                  <div key={m.id || m.tempId || i}>
                    {showSep && <div className="text-center text-[10px] text-slate-400 my-2 font-medium">{fmtSeparator(m.at)}</div>}
                    <div className={`flex ${out ? 'justify-end' : 'justify-start'} mb-1`}>
                      <div
                        className={`max-w-[78%] rounded-2xl px-3 py-2 text-[15px] leading-snug break-words whitespace-pre-wrap ${out ? 'text-white rounded-br-md' : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md'} ${m.status === 'sending' ? 'opacity-70' : ''}`}
                        style={out ? { background: failed ? '#dc2626' : BRAND } : {}}
                      >
                        {m.text}
                      </div>
                    </div>
                    {failed && (
                      <div className="flex justify-end mb-1">
                        <button onClick={() => sendInThread(m.text)} className="inline-flex items-center gap-1 text-[10px] text-red-600 font-semibold">
                          <AlertCircle size={11} /> Not delivered · Tap to retry
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="border-t p-2 flex-shrink-0 bg-white" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
              <div className="flex items-end gap-2">
                <textarea
                  ref={composerRef} value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInThread(); } }}
                  placeholder="Text message"
                  className="flex-1 border border-slate-300 rounded-2xl px-3.5 py-2 text-[15px] resize-none max-h-32 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
                />
                <button
                  onClick={() => sendInThread()} disabled={!draft.trim() || sending}
                  className="flex-shrink-0 w-9 h-9 rounded-full text-white flex items-center justify-center disabled:opacity-30 transition-opacity"
                  style={{ background: BRAND }} aria-label="Send"
                >
                  <Send size={17} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// A labeled contact section in the New Message picker. Renders nothing when empty.
function Section({ title, items, onPick, keyer }) {
  if (!items || !items.length) return null;
  return (
    <div>
      <div className="px-3 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400 bg-white sticky top-0">{title}</div>
      {items.map((c) => <ContactRow key={keyer(c)} contact={c} onClick={onPick} />)}
    </div>
  );
}

function ContactRow({ contact, onClick, subtitle, forceName }) {
  const name = forceName || contact.name;
  const sub = subtitle || (contact.name ? fmtPhone(contact.phone) : '');
  return (
    <button onClick={() => onClick(contact)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50">
      <Avatar name={contact.name} phone={contact.phone} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[15px] font-semibold text-slate-800 truncate">{name || fmtPhone(contact.phone)}</span>
          {contact.group && contact.group !== 'customer' && <GroupChip group={contact.group} />}
        </div>
        {sub && <div className="text-[12px] text-slate-400 truncate">{sub}</div>}
      </div>
      <ChevronRight size={16} className="text-slate-300 flex-shrink-0" />
    </button>
  );
}
