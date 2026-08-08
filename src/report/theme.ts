/**
 * Report styling.
 *
 * The categorical palette is not chosen by eye: each set was checked with a
 * CVD-separation validator against its own surface (lightness band, chroma
 * floor, adjacent-pair separation under protan/deutan/tritan simulation, and
 * contrast). Light and dark are stepped independently rather than one being an
 * automatic inversion of the other, which is what produces washed-out dark
 * charts.
 */
export const CATEGORICAL_LIGHT = ["#1E7A3C", "#3A6FF7", "#E8591A", "#8C4A9E"];
export const CATEGORICAL_DARK = ["#3FA866", "#5B8DEE", "#DB6E33", "#AC74C4"];

export const REPORT_CSS = `
:root{
  --bg:#FAFAF7; --panel:#FFFFFF; --ink:#1C2420; --sub:#57635C; --faint:#8A948E;
  --line:#E3E6DF; --accent:#135A2A; --accent-ink:#0E4721;
  --c1:${CATEGORICAL_LIGHT[0]}; --c2:${CATEGORICAL_LIGHT[1]};
  --c3:${CATEGORICAL_LIGHT[2]}; --c4:${CATEGORICAL_LIGHT[3]};
  --warn:#A94A12; --bad:#B3261E; --chipbg:#EEF3EC; --track:#EFF1EA; --hot:#FDF1E7;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#121814; --panel:#1A211C; --ink:#E7ECE7; --sub:#9FABA2; --faint:#6E7972;
  --line:#2A332C; --accent:#5FBF7F; --accent-ink:#7ACB94;
  --c1:${CATEGORICAL_DARK[0]}; --c2:${CATEGORICAL_DARK[1]};
  --c3:${CATEGORICAL_DARK[2]}; --c4:${CATEGORICAL_DARK[3]};
  --warn:#E59B62; --bad:#E5766B; --chipbg:#22301F; --track:#232B25; --hot:#2E2119;
}}
:root[data-theme="dark"]{
  --bg:#121814; --panel:#1A211C; --ink:#E7ECE7; --sub:#9FABA2; --faint:#6E7972;
  --line:#2A332C; --accent:#5FBF7F; --accent-ink:#7ACB94;
  --c1:${CATEGORICAL_DARK[0]}; --c2:${CATEGORICAL_DARK[1]};
  --c3:${CATEGORICAL_DARK[2]}; --c4:${CATEGORICAL_DARK[3]};
  --warn:#E59B62; --bad:#E5766B; --chipbg:#22301F; --track:#232B25; --hot:#2E2119;
}
:root[data-theme="light"]{
  --bg:#FAFAF7; --panel:#FFFFFF; --ink:#1C2420; --sub:#57635C; --faint:#8A948E;
  --line:#E3E6DF; --accent:#135A2A; --accent-ink:#0E4721;
  --c1:${CATEGORICAL_LIGHT[0]}; --c2:${CATEGORICAL_LIGHT[1]};
  --c3:${CATEGORICAL_LIGHT[2]}; --c4:${CATEGORICAL_LIGHT[3]};
  --warn:#A94A12; --bad:#B3261E; --chipbg:#EEF3EC; --track:#EFF1EA; --hot:#FDF1E7;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 -apple-system,"SF Pro Text","Segoe UI",Roboto,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1060px;margin:0 auto;padding:40px 24px 80px}
h1,h2,h3{font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em;text-wrap:balance}
h1{font-size:31px;line-height:1.15;font-weight:600;margin:6px 0 10px}
h2{font-size:20px;font-weight:600;margin:0 0 4px}
h3{font-size:16px;font-weight:600;margin:22px 0 6px}
.eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.sub{color:var(--sub);max-width:72ch}
.small{font-size:12.5px;color:var(--sub)}
.faint{color:var(--faint)}
.mono,td.n,th.n{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
section{margin-top:44px;padding-top:26px;border-top:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px;margin:26px 0 4px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.tile .v{font-family:"Avenir Next","Segoe UI",system-ui;font-size:26px;font-weight:600;
  letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile .l{font-size:12px;color:var(--sub);margin-top:2px;line-height:1.35}
.tile.good .v{color:var(--accent-ink)}
.tile.warn .v{color:var(--warn)}
.tile.bad .v{color:var(--bad)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);
   text-align:left;font-weight:600;padding:6px 10px 6px 0;border-bottom:1px solid var(--line)}
td{padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
td.n,th.n{text-align:right}
tr:hover td{background:color-mix(in srgb, var(--track) 55%, transparent)}
a{color:var(--accent-ink)}
a.pr{color:var(--accent-ink);text-decoration:none;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px}
a.pr:hover{text-decoration:underline}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chipbg);
  font-size:11.5px;font-weight:600;color:var(--accent-ink)}
.chip.bad{background:transparent;border:1px solid var(--bad);color:var(--bad)}
.bars{display:flex;flex-direction:column;gap:7px;margin:14px 0 4px}
.brow{display:grid;grid-template-columns:minmax(120px,34%) 1fr;gap:12px;align-items:center}
.brow .bl{font-size:13px;color:var(--sub);text-align:right;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.btrack{position:relative;height:18px;background:var(--track);border-radius:4px}
.bfill{position:absolute;top:0;bottom:0;left:0;border-radius:2px 4px 4px 2px;min-width:2px}
.bval{position:absolute;top:50%;transform:translateY(-50%);
  font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px;color:var(--ink);white-space:nowrap}
.stack{display:flex;height:26px;border-radius:5px;overflow:hidden;gap:2px;margin:12px 0 8px}
.stack div{min-width:3px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--sub);margin-bottom:6px}
.legend .k{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:26px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}.brow{grid-template-columns:minmax(90px,38%) 1fr}}
.scrollbox{overflow:auto;max-height:560px;border:1px solid var(--line);border-radius:8px;
  background:var(--panel);scrollbar-color:var(--faint) transparent}
.scrollbox table{font-size:12.5px;min-width:900px}
.scrollbox th{position:sticky;top:0;background:var(--panel);z-index:1;padding:8px 10px}
.scrollbox td{padding:5px 10px;border-bottom:1px solid var(--line)}
.hotrow td{background:var(--hot)}
.warnbox{background:var(--panel);border:1px solid var(--warn);border-left-width:3px;
  border-radius:8px;padding:12px 16px;margin:18px 0}
.warnbox ul{margin:6px 0 0;padding-left:20px}
.warnbox li{margin:4px 0;font-size:13px;color:var(--sub)}
footer{margin-top:56px;font-size:12px;color:var(--faint);border-top:1px solid var(--line);padding-top:14px}
code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.92em;background:var(--track);
  padding:1px 5px;border-radius:4px}
`;
