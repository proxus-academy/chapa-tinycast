import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useEffect, useMemo, useState } from "react";

// Chapa guarda el historial solo en este Mac (esquema: Sources/ChapaCore/Datos/History.swift).
const DB = join(homedir(), "Library", "Application Support", "Chapa", "chapa.sqlite");
const LIMIT = 1000;

// Solo los dictados terminados (status NULL): sin pendientes, fallidos ni cancelados.
const SQL = `
SELECT id, ts, app_name AS app, duration, raw, final, NULLIF(edited, '') AS edited, engine, source
FROM dictations
WHERE status IS NULL AND COALESCE(final, '') <> ''
ORDER BY ts DESC
LIMIT ${LIMIT};`;

type Dictation = {
  id: string;
  ts: number;
  app: string | null;
  duration: number | null;
  raw: string | null;
  final: string;
  edited: string | null;
  engine: string | null;
  source: string | null;
};

type State = { items: Dictation[]; error?: string; loading: boolean };

// /usr/bin/sqlite3 viene con macOS y, a diferencia de leer una copia del fichero, ve el WAL:
// el último dictado aparece aunque Chapa aún no haya hecho checkpoint.
function readHistory(): Promise<Dictation[]> {
  return new Promise((resolve, reject) => {
    if (!existsSync(DB)) {
      reject(new Error("No encuentro el historial de Chapa en este Mac. ¿Está instalada y has dictado algo?"));
      return;
    }
    execFile("/usr/bin/sqlite3", ["-readonly", "-json", DB, SQL], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`No he podido leer el historial: ${err.message}`));
      const out = stdout.trim();
      resolve(out ? (JSON.parse(out) as Dictation[]) : []);
    });
  });
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function dayLabel(d: Date): string {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days === 0) return "Hoy";
  if (days === 1) return "Ayer";
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  const s = d.toLocaleDateString("es-ES", opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const time = (d: Date) => d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export default function Command() {
  const [state, setState] = useState<State>({ items: [], loading: true });
  const [search, setSearch] = useState("");
  const [app, setApp] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    readHistory()
      .then((items) => setState({ items, loading: false }))
      .catch((e: Error) => setState({ items: [], loading: false, error: e.message }));
  }, [reload]);

  const apps = useMemo(() => {
    const count = new Map<string, number>();
    for (const d of state.items) if (d.app) count.set(d.app, (count.get(d.app) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [state.items]);

  // Búsqueda propia: en todo el texto, sin distinguir mayúsculas ni tildes.
  const sections = useMemo(() => {
    const q = fold(search.trim());
    const out: { title: string; items: Dictation[] }[] = [];
    for (const d of state.items) {
      if (app && d.app !== app) continue;
      if (q && !fold(`${d.final} ${d.edited ?? ""}`).includes(q)) continue;
      const title = dayLabel(new Date(d.ts * 1000));
      const last = out[out.length - 1];
      if (last?.title === title) last.items.push(d);
      else out.push({ title, items: [d] });
    }
    return out;
  }, [state.items, search, app]);

  const refresh = (
    <Action
      title="Recargar"
      icon={Icon.ArrowClockwise}
      shortcut={{ modifiers: ["cmd"], key: "r" }}
      onAction={() => setReload((n) => n + 1)}
    />
  );

  return (
    <List
      isLoading={state.loading}
      isShowingDetail={sections.length > 0}
      filtering={false}
      onSearchTextChange={setSearch}
      searchBarPlaceholder="Buscar en lo dictado…"
      searchBarAccessory={
        <List.Dropdown tooltip="App" storeValue onChange={setApp}>
          <List.Dropdown.Item title="Todas las apps" value="" />
          {apps.map((a) => (
            <List.Dropdown.Item key={a} title={a} value={a} />
          ))}
        </List.Dropdown>
      }
    >
      {state.error ? (
        <List.EmptyView icon={Icon.Warning} title="No puedo leer el historial" description={state.error} />
      ) : (
        <List.EmptyView
          icon={Icon.Microphone}
          title={search || app ? "Nada coincide" : "Aún no has dictado nada"}
          actions={<ActionPanel>{refresh}</ActionPanel>}
        />
      )}
      {sections.map((s) => (
        <List.Section key={s.title} title={s.title} subtitle={String(s.items.length)}>
          {s.items.map((d) => {
            const date = new Date(d.ts * 1000);
            return (
              <List.Item
                key={d.id}
                title={oneLine(d.final).slice(0, 140)}
                accessories={[{ text: time(date), tooltip: date.toLocaleString("es-ES") }]}
                detail={
                  <List.Item.Detail
                    markdown={d.final}
                    metadata={
                      <List.Item.Detail.Metadata>
                        <List.Item.Detail.Metadata.Label title="App" text={d.app ?? "—"} />
                        <List.Item.Detail.Metadata.Label title="Cuándo" text={date.toLocaleString("es-ES")} />
                        <List.Item.Detail.Metadata.Label
                          title="Duración"
                          text={`${Math.round(d.duration ?? 0)} s · ${words(d.final)} palabras`}
                        />
                        {d.engine ? <List.Item.Detail.Metadata.Label title="Motor" text={d.engine} /> : null}
                        {d.source && d.source !== "chapa" ? (
                          <List.Item.Detail.Metadata.Label title="Importado de" text={d.source} />
                        ) : null}
                        {d.edited ? (
                          <List.Item.Detail.Metadata.Label title="Corregido a mano" text="Sí (⌘⇧E lo copia)" />
                        ) : null}
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.CopyToClipboard title="Copiar" content={d.final} />
                    <Action.Paste title="Pegar en la app" content={d.final} />
                    {d.edited ? (
                      <Action.CopyToClipboard
                        title="Copiar con tus correcciones"
                        content={d.edited}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
                      />
                    ) : null}
                    {d.raw ? (
                      <Action.CopyToClipboard
                        title="Copiar sin pulir"
                        content={d.raw}
                        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                      />
                    ) : null}
                    {refresh}
                  </ActionPanel>
                }
              />
            );
          })}
        </List.Section>
      ))}
    </List>
  );
}
