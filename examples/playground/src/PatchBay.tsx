import type { ProviderId, ProviderOverview } from "cli-funnel/client";

export const CABLE: Record<string, string> = {
  claude: "#2447C6",
  codex: "#12805C",
  agent: "#7B3FA0",
  antigravity: "#B7861A",
  "anthropic-api": "#2447C6",
  "openai-api": "#12805C",
  "gemini-api": "#B7861A",
};

const ROW = 46;
const TOP = 34;
const LEFT_X = 214;
const RIGHT_X = 690;

export function PatchBay({
  providers,
  selected,
  running,
  onSelect,
}: {
  providers: ProviderOverview[];
  selected?: ProviderId;
  running: boolean;
  onSelect: (id: ProviderId) => void;
}) {
  const rows = providers.filter((p) => p.capabilities.access.length > 0 || p.installation.installed).slice(0, 4);
  const height = TOP * 2 + ROW * Math.max(rows.length - 1, 1);
  const outY = height / 2;
  const index = rows.findIndex((p) => p.id === selected);
  const y = TOP + index * ROW;
  const color = selected ? CABLE[selected] ?? "#13212B" : "#13212B";
  const path = `M ${LEFT_X} ${y} C ${LEFT_X + 190} ${y}, ${RIGHT_X - 190} ${outY}, ${RIGHT_X} ${outY}`;

  return (
    <figure className="bay" aria-label="Provider routing">
      <svg viewBox={`0 0 900 ${height}`} role="group" aria-label="Selected provider connects to your app">
        <defs>
          <filter id="drop" x="-5%" y="-20%" width="110%" height="150%">
            <feDropShadow dx="0" dy="2" stdDeviation="1.6" floodColor="#13212B" floodOpacity="0.22" />
          </filter>
        </defs>

        {rows.map((p, i) => {
          const cy = TOP + i * ROW;
          const on = p.id === selected;
          const ready = p.installation.installed && p.auth?.loggedIn;
          return (
            <g key={p.id} className="jack" data-on={on} onClick={() => p.installation.installed && onSelect(p.id)} tabIndex={0} role="button" aria-pressed={on} aria-label={`${p.displayName}${ready ? "" : p.installation.installed ? ", signed out" : ", not installed"}`} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && p.installation.installed && onSelect(p.id)}>
              <rect x="0" y={cy - ROW / 2 + 3} width="900" height={ROW - 6} fill="transparent" />
              <text x="36" y={cy - 2} className="jack-name">{p.displayName}</text>
              <text x="36" y={cy + 14} className="jack-state">
                {!p.installation.installed ? "not installed" : ready ? "signed in" : "signed out"}
              </text>
              <circle cx={LEFT_X} cy={cy} r="12" className="jack-ring" />
              <circle cx={LEFT_X} cy={cy} r="6" fill={on ? color : "#13212B"} opacity={p.installation.installed ? 1 : 0.25} />
            </g>
          );
        })}

        <g>
          <circle cx={RIGHT_X} cy={outY} r="16" className="jack-ring" />
          <circle cx={RIGHT_X} cy={outY} r="8" fill={color} />
          <text x={RIGHT_X + 34} y={outY - 4} className="jack-name">Your app</text>
          <text x={RIGHT_X + 34} y={outY + 16} className="jack-state">funnel.run()</text>
        </g>

        {index >= 0 && (
          <>
            <path d={path} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" filter="url(#drop)" />
            {running && <path d={path} className="pulse" fill="none" strokeWidth="3" strokeLinecap="round" />}
          </>
        )}
      </svg>
    </figure>
  );
}
