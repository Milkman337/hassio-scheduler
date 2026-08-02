/**
 * Scheduler - sidebar panel.
 *
 * Plain custom element (no build step / no external dependencies) so it can
 * be shipped as-is through HACS. Rich inputs (entity/action pickers, date &
 * time pickers, icon picker, etc.) are provided by <ha-selector>, which is
 * already registered globally by the Home Assistant frontend, giving this
 * panel the exact same editing power as the built-in automation editor.
 */

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_LABELS = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const ROW_HEIGHT = 48; // px per hour in the calendar grid
const REFRESH_INTERVAL_MS = 60000;

// Heating grid: one column per day, one row per 30-minute slot.
const HEATING_SLOT_MINUTES = 30;
const HEATING_ROWS = (24 * 60) / HEATING_SLOT_MINUTES;
const HEATING_ROW_HEIGHT = 15; // px
const HEATING_ERASE = "__erase__";
const HEATING_CUSTOM = "__custom__";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toLocalISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function weekdayKey(date) {
  return WEEKDAYS[(date.getDay() + 6) % 7];
}

function uuid() {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function timeToMinutes(hhmmss) {
  if (!hhmmss) return null;
  const [h, m] = hhmmss.split(":").map(Number);
  return h * 60 + m;
}

/** Best-effort local clock time (minutes since midnight) for a sun spec, for
 * calendar placement only. Actual firing is computed server-side. */
function sunSpecToMinutes(hass, spec) {
  const sun = hass.states["sun.sun"];
  const attr = spec.event === "sunrise" ? "next_rising" : "next_setting";
  let base = 12 * 60;
  if (sun && sun.attributes && sun.attributes[attr]) {
    const dt = new Date(sun.attributes[attr]);
    base = dt.getHours() * 60 + dt.getMinutes();
  }
  return base + (spec.offset_minutes || 0);
}

function specToMinutes(hass, spec) {
  if (!spec) return null;
  if (spec.kind === "time") return timeToMinutes(spec.at);
  if (spec.kind === "sun") return sunSpecToMinutes(hass, spec);
  return null;
}

function slotActiveOn(schedule, slot, date) {
  const iso = toLocalISODate(date);
  if (schedule.start_date && iso < schedule.start_date) return false;
  if (schedule.end_date && iso > schedule.end_date) return false;
  if (slot.recurrence === "once") return slot.date === iso;
  return (slot.weekdays || []).includes(weekdayKey(date));
}

function describeSlot(slot) {
  const start = slot.start && slot.start.kind === "time"
    ? slot.start.at.slice(0, 5)
    : slot.start
    ? `${slot.start.event === "sunrise" ? "Sunrise" : "Sunset"}${
        slot.start.offset_minutes ? ` ${slot.start.offset_minutes > 0 ? "+" : ""}${slot.start.offset_minutes}m` : ""
      }`
    : "?";
  let text = start;
  if (slot.end) {
    const end = slot.end.kind === "time"
      ? slot.end.at.slice(0, 5)
      : `${slot.end.event === "sunrise" ? "Sunrise" : "Sunset"}${
          slot.end.offset_minutes ? ` ${slot.end.offset_minutes > 0 ? "+" : ""}${slot.end.offset_minutes}m` : ""
        }`;
    text += ` → ${end}`;
  }
  const days = slot.recurrence === "once" ? slot.date : (slot.weekdays || []).join(", ");
  return `${text} · ${days || "no days set"}`;
}

function emptyTimeslot() {
  return {
    id: uuid(),
    recurrence: "weekly",
    weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    date: toLocalISODate(new Date()),
    start: { kind: "time", at: "18:00:00" },
    end: null,
    actions: [],
    end_actions: [],
    once: false,
  };
}

function emptySchedule() {
  return {
    name: "",
    icon: "mdi:calendar-clock",
    color: "#03a9f4",
    enabled: true,
    start_date: null,
    end_date: null,
    skip_dates: [],
    timeslots: [emptyTimeslot()],
  };
}

// ---------------------------------------------------------- heating grid

function idxToHHMM(idx) {
  const minutes = idx * HEATING_SLOT_MINUTES;
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function hhmmToIdx(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(":").map(Number);
  return Math.round((h * 60 + m) / HEATING_SLOT_MINUTES);
}

/** Expand a day's compressed segment list into one cell per 30-minute slot.
 * Each cell is `null` (gap - falls back to the program's default preset) or
 * `{preset_id, temperature}`. */
function expandDayToCells(program, day) {
  const cells = new Array(HEATING_ROWS).fill(null);
  for (const seg of (program.grid && program.grid[day]) || []) {
    const start = hhmmToIdx(seg.start);
    const end = hhmmToIdx(seg.end);
    for (let i = Math.max(0, start); i < Math.min(HEATING_ROWS, end); i++) {
      cells[i] = { preset_id: seg.preset_id || null, temperature: seg.temperature ?? null };
    }
  }
  return cells;
}

/** Run-length encode a cell array back into the compressed segment format. */
function compressCellsToSegments(cells) {
  const segments = [];
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i];
    if (!cell) {
      i++;
      continue;
    }
    let j = i + 1;
    while (
      j < cells.length &&
      cells[j] &&
      cells[j].preset_id === cell.preset_id &&
      cells[j].temperature === cell.temperature
    ) {
      j++;
    }
    segments.push({
      start: idxToHHMM(i) + ":00",
      end: idxToHHMM(j) + ":00",
      preset_id: cell.preset_id || null,
      temperature: cell.temperature ?? null,
    });
    i = j;
  }
  return segments;
}

function findPreset(program, presetId) {
  return (program.presets || []).find((p) => p.id === presetId) || null;
}

/** Resolve the effective temperature/preset for a single grid cell (for
 * painting/legend display only - the backend is authoritative at runtime). */
function cellDisplay(program, cell) {
  if (cell) {
    if (cell.temperature !== null && cell.temperature !== undefined) {
      return { temperature: cell.temperature, label: `${cell.temperature}°`, color: "#9e9e9e", isGap: false };
    }
    const preset = findPreset(program, cell.preset_id);
    if (preset) return { temperature: preset.temperature, label: preset.name, color: preset.color, isGap: false };
  }
  const def = findPreset(program, program.default_preset_id);
  if (def) return { temperature: def.temperature, label: `${def.name} (default)`, color: def.color, isGap: true };
  return { temperature: null, label: "Not set", color: "#9e9e9e", isGap: true };
}

function emptyHeatingPreset(name, temperature, color, icon) {
  return { id: uuid(), name, temperature, color, icon };
}

function emptyHeatingProgram() {
  const presets = [
    emptyHeatingPreset("Frost protection", 7, "#4fc3f7", "mdi:snowflake"),
    emptyHeatingPreset("Eco", 17, "#81c784", "mdi:leaf"),
    emptyHeatingPreset("Comfort", 21, "#ffb74d", "mdi:sofa"),
    emptyHeatingPreset("Boost", 23, "#e57373", "mdi:fire"),
  ];
  return {
    name: "",
    icon: "mdi:radiator",
    color: "#ff7043",
    enabled: true,
    climate_entities: [],
    hvac_mode: null,
    presets,
    default_preset_id: presets[1].id,
    grid: Object.fromEntries(WEEKDAYS.map((d) => [d, []])),
  };
}

class HassioSchedulerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._tab = "schedule";
    this._schedules = [];
    this._loading = true;
    this._view = "week";
    this._cursor = startOfWeek(new Date());
    this._dayCursor = new Date();
    this._editing = null;
    this._editingId = null;
    this._filter = "";
    this._initialized = false;

    // Heating tab state
    this._heatingPrograms = [];
    this._heatingLoading = true;
    this._selectedHeatingId = null;
    this._heatingEditing = null;
    this._heatingEditingId = null;
    this._paintBrush = null;
    this._paintDragging = false;
    this._paintDay = null;
    this._paintProgramId = null;
    this._heatingSaveState = "idle";
    this._heatingSaveTimer = null;
    this._paused = false;
    this._activePopover = null;
    this._onGlobalPointerUp = () => this._endPaint();
    this._onDocClickClosePopover = (e) => {
      if (this._activePopover && !e.composedPath().includes(this._activePopover)) {
        this._closePopover();
      }
    };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._init();
    }
  }

  get hass() {
    return this._hass;
  }

  set narrow(v) {
    this._narrow = v;
  }

  connectedCallback() {
    if (this._hass && !this._initialized) {
      this._initialized = true;
      this._init();
    }
    if (!this._refreshTimer) {
      this._refreshTimer = setInterval(() => {
        this._loadSchedules();
        this._loadHeatingPrograms();
        this._loadGlobalState();
      }, REFRESH_INTERVAL_MS);
    }
    window.addEventListener("pointerup", this._onGlobalPointerUp);
  }

  disconnectedCallback() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    window.removeEventListener("pointerup", this._onGlobalPointerUp);
  }

  async _init() {
    this._injectBaseStyles();
    this._renderShell();
    await Promise.all([this._loadSchedules(), this._loadHeatingPrograms(), this._loadGlobalState()]);
  }

  async _loadGlobalState() {
    if (!this._hass) return;
    try {
      const resp = await this._hass.callWS({ type: "hassio_scheduler/get_global_state" });
      this._paused = !!resp.paused;
    } catch (err) {
      console.error("Scheduler: failed to load global state", err); // eslint-disable-line no-console
    }
    this._updatePauseUI();
  }

  async _loadSchedules() {
    if (!this._hass) return;
    try {
      const resp = await this._hass.callWS({ type: "hassio_scheduler/list" });
      this._schedules = resp.schedules || [];
    } catch (err) {
      console.error("Scheduler: failed to load schedules", err); // eslint-disable-line no-console
    }
    this._loading = false;
    if (this._tab === "schedule") this._renderMain();
  }

  async _loadHeatingPrograms() {
    if (!this._hass) return;
    try {
      const resp = await this._hass.callWS({ type: "hassio_scheduler/heating_list" });
      this._heatingPrograms = resp.programs || [];
      if (this._selectedHeatingId && !this._heatingPrograms.some((p) => p.id === this._selectedHeatingId)) {
        this._selectedHeatingId = null;
      }
      if (!this._selectedHeatingId && this._heatingPrograms.length) {
        this._selectedHeatingId = this._heatingPrograms[0].id;
      }
    } catch (err) {
      console.error("Scheduler: failed to load heating programs", err); // eslint-disable-line no-console
    }
    this._heatingLoading = false;
    if (this._tab === "heating") this._renderMain();
  }

  // ---------------------------------------------------------------- shell

  _injectBaseStyles() {
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadowRoot.appendChild(style);
  }

  _renderShell() {
    const root = document.createElement("div");
    root.className = "root";
    root.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-title">
          <ha-icon icon="mdi:calendar-clock"></ha-icon>
          <span>Scheduler</span>
        </div>
        <nav class="ha-tabs" id="tabs"></nav>
        <div class="toolbar-spacer"></div>
        <button class="icon-btn" id="pause-btn" title="Pause everything"><ha-icon icon="mdi:pause-circle-outline"></ha-icon></button>
        <button class="icon-btn" id="menu-btn" title="More"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
      </div>
      <div class="pause-banner" id="pause-banner" style="display:none">
        <ha-icon icon="mdi:pause-circle"></ha-icon>
        <span>Scheduler is paused — nothing will run until you resume it.</span>
        <button class="btn btn-flat" id="resume-btn">Resume</button>
      </div>
      <div class="subheader">
        <div class="toolbar-nav" id="nav"></div>
        <div class="toolbar-views" id="view-switch"></div>
        <button class="btn btn-primary" id="add-btn"></button>
      </div>
      <div class="content" id="content"></div>
    `;
    this.shadowRoot.appendChild(root);
    this._contentEl = root.querySelector("#content");
    this._renderTabs(root.querySelector("#tabs"));
    this._renderShellSection();
    root.querySelector("#pause-btn").addEventListener("click", () => this._togglePause());
    root.querySelector("#resume-btn").addEventListener("click", () => this._setPaused(false));
    root.querySelector("#menu-btn").addEventListener("click", (e) => this._openMainMenu(e.currentTarget));
    this._updatePauseUI();
  }

  _updatePauseUI() {
    const btn = this.shadowRoot.querySelector("#pause-btn");
    const banner = this.shadowRoot.querySelector("#pause-banner");
    if (!btn || !banner) return;
    btn.innerHTML = this._paused
      ? `<ha-icon icon="mdi:play-circle"></ha-icon>`
      : `<ha-icon icon="mdi:pause-circle-outline"></ha-icon>`;
    btn.title = this._paused ? "Resume everything" : "Pause everything";
    banner.style.display = this._paused ? "flex" : "none";
  }

  async _togglePause() {
    if (!this._paused && !confirm("Pause Scheduler? No schedules or heating programs will run until you resume.")) {
      return;
    }
    await this._setPaused(!this._paused);
  }

  async _setPaused(paused) {
    await this._hass.callWS({ type: "hassio_scheduler/set_paused", paused });
    this._paused = paused;
    this._updatePauseUI();
  }

  _openMainMenu(anchorEl) {
    this._openPopover(anchorEl, (pop) => {
      pop.innerHTML = `
        <button class="popover-item" data-a="export"><ha-icon icon="mdi:download"></ha-icon> Export configuration</button>
        <button class="popover-item" data-a="import"><ha-icon icon="mdi:upload"></ha-icon> Import configuration</button>
      `;
      pop.querySelector('[data-a="export"]').addEventListener("click", () => {
        this._closePopover();
        this._exportConfig();
      });
      pop.querySelector('[data-a="import"]').addEventListener("click", () => {
        this._closePopover();
        this._importConfig();
      });
    });
  }

  _exportConfig() {
    const data = {
      hassio_scheduler_backup: true,
      version: 1,
      exported_at: new Date().toISOString(),
      schedules: this._schedules.map((s) => this._scheduleUpdatePayload(s)),
      heating_programs: this._heatingPrograms.map((p) => this._heatingUpdatePayload(p)),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scheduler-backup-${toLocalISODate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _importConfig() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch (err) {
        console.error("Scheduler: import failed to parse file", err); // eslint-disable-line no-console
        alert("Could not read this file - it is not valid JSON.");
        return;
      }
      const schedules = Array.isArray(data.schedules) ? data.schedules : [];
      const programs = Array.isArray(data.heating_programs) ? data.heating_programs : [];
      if (!schedules.length && !programs.length) {
        alert("This file doesn't contain any Scheduler schedules or heating programs.");
        return;
      }
      if (
        !confirm(
          `Import ${schedules.length} schedule(s) and ${programs.length} heating program(s)? They will be added as new items alongside anything you already have.`
        )
      ) {
        return;
      }
      try {
        for (const s of schedules) {
          const payload = { ...s };
          delete payload.id;
          delete payload.next_run;
          delete payload.last_triggered;
          (payload.timeslots || []).forEach((t) => delete t.id);
          await this._hass.callWS({ type: "hassio_scheduler/create", schedule: payload });
        }
        for (const p of programs) {
          const payload = { ...p };
          delete payload.id;
          delete payload.target_temperature;
          delete payload.source;
          delete payload.override;
          (payload.presets || []).forEach((pr) => delete pr.id);
          await this._hass.callWS({ type: "hassio_scheduler/heating_create", program: payload });
        }
        await Promise.all([this._loadSchedules(), this._loadHeatingPrograms()]);
        if (this._tab === "schedule" || this._tab === "heating") this._renderMain();
        alert("Import complete.");
      } catch (err) {
        console.error("Scheduler: import failed", err); // eslint-disable-line no-console
        alert("Something went wrong while importing. Some items may have been created - check the Schedule and Heating tabs.");
      }
    });
    input.click();
  }

  _renderTabs(el) {
    const tabs = [
      { id: "schedule", label: "Schedule", icon: "mdi:calendar-clock" },
      { id: "heating", label: "Heating", icon: "mdi:radiator" },
    ];
    el.innerHTML = tabs
      .map(
        (t) =>
          `<button class="ha-tab ${this._tab === t.id ? "ha-tab-active" : ""}" data-tab="${t.id}">
            <ha-icon icon="${t.icon}"></ha-icon><span>${t.label}</span>
          </button>`
      )
      .join("") + `<span class="ha-tab-indicator" id="tab-indicator"></span>`;
    el.querySelectorAll(".ha-tab").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (this._tab === btn.dataset.tab) return;
        this._tab = btn.dataset.tab;
        this._renderTabs(el);
        this._renderShellSection();
      })
    );
    requestAnimationFrame(() => this._positionTabIndicator(el));
  }

  _positionTabIndicator(el) {
    const active = el.querySelector(".ha-tab-active");
    const indicator = el.querySelector("#tab-indicator");
    if (!active || !indicator) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  _renderViewSwitch(el) {
    el.innerHTML = ["day", "week", "list"]
      .map(
        (v) =>
          `<button data-view="${v}" class="chip ${this._view === v ? "chip-active" : ""}">${
            v[0].toUpperCase() + v.slice(1)
          }</button>`
      )
      .join("");
    el.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () => {
        this._view = btn.dataset.view;
        this._renderShellSection();
      })
    );
  }

  _renderNav(el) {
    el.style.display = "";
    if (this._view === "list") {
      el.innerHTML = `<input class="search" id="search" type="search" placeholder="Search schedules…" value="${this._filter}"/>`;
      el.querySelector("#search").addEventListener("input", (e) => {
        this._filter = e.target.value;
        this._renderMain();
      });
      return;
    }
    const label = this._view === "day" ? this._formatDay(this._dayCursor) : this._formatWeekRange();
    el.innerHTML = `
      <button class="icon-btn" id="prev" title="Previous"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
      <button class="btn btn-flat" id="today">Today</button>
      <button class="icon-btn" id="next" title="Next"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
      <span class="nav-label">${label}</span>
    `;
    el.querySelector("#prev").addEventListener("click", () => this._navigate(-1));
    el.querySelector("#next").addEventListener("click", () => this._navigate(1));
    el.querySelector("#today").addEventListener("click", () => {
      this._cursor = startOfWeek(new Date());
      this._dayCursor = new Date();
      this._renderShellSection();
    });
  }

  _navigate(dir) {
    if (this._view === "day") {
      this._dayCursor = addDays(this._dayCursor, dir);
    } else {
      this._cursor = addDays(this._cursor, dir * 7);
    }
    this._renderShellSection();
  }

  _formatDay(d) {
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  _formatWeekRange() {
    const end = addDays(this._cursor, 6);
    const opts = { month: "short", day: "numeric" };
    return `${this._cursor.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}, ${end.getFullYear()}`;
  }

  _renderShellSection() {
    const root = this.shadowRoot.querySelector(".root");
    const viewSwitchEl = root.querySelector("#view-switch");
    const navEl = root.querySelector("#nav");
    const addBtn = root.querySelector("#add-btn");

    if (this._tab === "schedule") {
      viewSwitchEl.style.display = "";
      this._renderViewSwitch(viewSwitchEl);
      this._renderNav(navEl);
      addBtn.textContent = "+ New schedule";
      addBtn.onclick = () => this._openEditor(null);
    } else {
      viewSwitchEl.style.display = "none";
      navEl.style.display = "none";
      addBtn.textContent = "+ New program";
      addBtn.onclick = () => this._openHeatingEditor(null);
    }
    this._renderMain();
  }

  _renderMain() {
    if (!this._contentEl) return;
    this._contentEl.innerHTML = "";
    if (this._tab === "heating") {
      this._renderHeatingTab();
      return;
    }
    if (this._loading) {
      this._contentEl.innerHTML = `<div class="empty">Loading schedules…</div>`;
      return;
    }
    if (this._view === "week") this._renderCalendar(addDaysRange(this._cursor, 7));
    else if (this._view === "day") this._renderCalendar([this._dayCursor]);
    else this._renderList();
  }

  // ------------------------------------------------------------ calendar

  _renderCalendar(days) {
    const wrap = document.createElement("div");
    wrap.className = "cal-wrap";

    const header = document.createElement("div");
    header.className = "cal-header";
    header.style.gridTemplateColumns = `56px repeat(${days.length}, 1fr)`;
    header.innerHTML =
      `<div class="cal-gutter-head"></div>` +
      days
        .map((d) => {
          const isToday = toLocalISODate(d) === toLocalISODate(new Date());
          return `<div class="cal-day-head ${isToday ? "today" : ""}">
            <div class="cal-day-name">${d.toLocaleDateString(undefined, { weekday: "short" })}</div>
            <div class="cal-day-num">${d.getDate()}</div>
          </div>`;
        })
        .join("");
    wrap.appendChild(header);

    const body = document.createElement("div");
    body.className = "cal-body";
    body.style.gridTemplateColumns = `56px repeat(${days.length}, 1fr)`;
    body.style.height = `${ROW_HEIGHT * 24}px`;

    const gutter = document.createElement("div");
    gutter.className = "cal-gutter";
    for (let h = 0; h < 24; h++) {
      const cell = document.createElement("div");
      cell.className = "cal-hour-label";
      cell.style.top = `${h * ROW_HEIGHT}px`;
      cell.textContent = `${pad2(h)}:00`;
      gutter.appendChild(cell);
    }
    body.appendChild(gutter);

    days.forEach((day) => {
      const col = document.createElement("div");
      col.className = "cal-col";
      for (let h = 0; h < 24; h++) {
        const slot = document.createElement("div");
        slot.className = "cal-hour-slot";
        slot.style.top = `${h * ROW_HEIGHT}px`;
        slot.style.height = `${ROW_HEIGHT}px`;
        slot.addEventListener("click", () => this._openEditor(null, { date: day, hour: h }));
        col.appendChild(slot);
      }

      const isToday = toLocalISODate(day) === toLocalISODate(new Date());
      if (isToday) {
        const now = new Date();
        const top = ((now.getHours() * 60 + now.getMinutes()) / 60) * ROW_HEIGHT;
        const nowLine = document.createElement("div");
        nowLine.className = "cal-now-line";
        nowLine.style.top = `${top}px`;
        col.appendChild(nowLine);
      }

      this._occurrencesForDay(day).forEach(({ schedule, slot: timeslot, startMin, endMin }) => {
        const block = document.createElement("div");
        const hasDuration = endMin !== null && endMin > startMin;
        block.className = `cal-event ${hasDuration ? "" : "cal-event-point"}`;
        block.style.top = `${(startMin / 60) * ROW_HEIGHT}px`;
        block.style.height = hasDuration
          ? `${Math.max((((endMin - startMin) / 60) * ROW_HEIGHT), 16)}px`
          : "20px";
        block.style.background = schedule.color || "#03a9f4";
        block.title = `${schedule.name}: ${describeSlot(timeslot)}`;
        block.innerHTML = `<ha-icon icon="${schedule.icon || "mdi:calendar-clock"}"></ha-icon><span>${schedule.name}</span>`;
        block.addEventListener("click", (e) => {
          e.stopPropagation();
          this._openEditor(schedule.id);
        });
        col.appendChild(block);
      });

      body.appendChild(col);
    });

    wrap.appendChild(body);
    this._contentEl.appendChild(wrap);
  }

  _occurrencesForDay(day) {
    const out = [];
    for (const schedule of this._schedules) {
      if (!schedule.enabled) continue;
      for (const slot of schedule.timeslots || []) {
        if (!slotActiveOn(schedule, slot, day)) continue;
        const startMin = specToMinutes(this._hass, slot.start);
        if (startMin === null) continue;
        let endMin = specToMinutes(this._hass, slot.end);
        if (endMin !== null && endMin <= startMin) endMin = 1440; // clip at midnight for display
        out.push({ schedule, slot, startMin, endMin });
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- list

  _renderList() {
    const filter = this._filter.trim().toLowerCase();
    const schedules = this._schedules
      .filter((s) => !filter || s.name.toLowerCase().includes(filter))
      .slice()
      .sort((a, b) => (a.next_run || "9999").localeCompare(b.next_run || "9999"));

    const wrap = document.createElement("div");
    wrap.className = "list-wrap";

    if (!schedules.length) {
      wrap.innerHTML = `<div class="empty">No schedules yet. Click "+ New schedule" to create one.</div>`;
      this._contentEl.appendChild(wrap);
      return;
    }

    schedules.forEach((schedule) => {
      const row = document.createElement("div");
      row.className = "list-row";
      const nextRun = schedule.next_run
        ? new Date(schedule.next_run).toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Not scheduled";
      row.innerHTML = `
        <div class="list-color" style="background:${schedule.color || "#03a9f4"}"></div>
        <ha-icon icon="${schedule.icon || "mdi:calendar-clock"}"></ha-icon>
        <div class="list-main">
          <div class="list-name">${schedule.name}</div>
          <div class="list-sub">${(schedule.timeslots || []).map(describeSlot).join(" · ") || "No timeslots"}</div>
        </div>
        <div class="list-next">${schedule.enabled ? nextRun : "Disabled"}</div>
        <label class="switch">
          <input type="checkbox" ${schedule.enabled ? "checked" : ""} id="toggle-${schedule.id}"/>
          <span class="slider"></span>
        </label>
        <button class="icon-btn" title="Run now" id="run-${schedule.id}"><ha-icon icon="mdi:play"></ha-icon></button>
        ${
          schedule.next_run
            ? `<button class="icon-btn" title="Skip next run" id="skip-${schedule.id}"><ha-icon icon="mdi:skip-next-outline"></ha-icon></button>`
            : ""
        }
        <button class="icon-btn" title="Duplicate" id="dup-${schedule.id}"><ha-icon icon="mdi:content-copy"></ha-icon></button>
        <button class="icon-btn" title="Edit" id="edit-${schedule.id}"><ha-icon icon="mdi:pencil"></ha-icon></button>
        <button class="icon-btn" title="Delete" id="del-${schedule.id}"><ha-icon icon="mdi:delete"></ha-icon></button>
      `;
      row.querySelector(`#toggle-${schedule.id}`).addEventListener("change", (e) =>
        this._setEnabled(schedule.id, e.target.checked)
      );
      row.querySelector(`#run-${schedule.id}`).addEventListener("click", () => this._runNow(schedule.id));
      const skipBtn = row.querySelector(`#skip-${schedule.id}`);
      if (skipBtn) skipBtn.addEventListener("click", () => this._skipNextRun(schedule));
      row.querySelector(`#dup-${schedule.id}`).addEventListener("click", () => this._duplicate(schedule.id));
      row.querySelector(`#edit-${schedule.id}`).addEventListener("click", () => this._openEditor(schedule.id));
      row.querySelector(`#del-${schedule.id}`).addEventListener("click", () => this._deleteSchedule(schedule.id));
      wrap.appendChild(row);
    });

    this._contentEl.appendChild(wrap);
  }

  async _setEnabled(id, enabled) {
    await this._hass.callWS({ type: "hassio_scheduler/set_enabled", schedule_id: id, enabled });
    await this._loadSchedules();
  }

  async _runNow(id) {
    await this._hass.callWS({ type: "hassio_scheduler/run_now", schedule_id: id });
  }

  async _duplicate(id) {
    await this._hass.callWS({ type: "hassio_scheduler/duplicate", schedule_id: id });
    await this._loadSchedules();
  }

  async _deleteSchedule(id) {
    const schedule = this._schedules.find((s) => s.id === id);
    if (!confirm(`Delete "${schedule ? schedule.name : "this schedule"}"? This cannot be undone.`)) return;
    await this._hass.callWS({ type: "hassio_scheduler/delete", schedule_id: id });
    await this._loadSchedules();
  }

  async _skipNextRun(schedule) {
    if (!schedule.next_run) return;
    const dateStr = schedule.next_run.slice(0, 10);
    const payload = this._scheduleUpdatePayload(schedule);
    payload.skip_dates = Array.from(new Set([...(payload.skip_dates || []), dateStr]));
    await this._hass.callWS({ type: "hassio_scheduler/update", schedule_id: schedule.id, schedule: payload });
    await this._loadSchedules();
  }

  // -------------------------------------------------------------- editor

  _openEditor(scheduleId, prefill) {
    this._editingId = scheduleId;
    if (scheduleId) {
      const existing = this._schedules.find((s) => s.id === scheduleId);
      this._editing = JSON.parse(JSON.stringify(existing));
    } else {
      this._editing = emptySchedule();
      if (prefill) {
        const slot = this._editing.timeslots[0];
        slot.weekdays = [weekdayKey(prefill.date)];
        slot.start = { kind: "time", at: `${pad2(prefill.hour)}:00:00` };
      }
    }
    this._renderEditorDialog();
  }

  _closeEditor() {
    this._editing = null;
    this._editingId = null;
    const dlg = this.shadowRoot.querySelector("#editor-dialog");
    if (dlg) dlg.remove();
  }

  _renderEditorDialog() {
    let dlg = this.shadowRoot.querySelector("#editor-dialog");
    if (!dlg) {
      dlg = document.createElement("div");
      dlg.id = "editor-dialog";
      dlg.className = "dialog-backdrop";
      this.shadowRoot.querySelector(".root").appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) this._closeEditor();
      });
    }
    dlg.innerHTML = "";
    const card = document.createElement("div");
    card.className = "dialog-card";
    card.innerHTML = `
      <div class="dialog-header">
        <span>${this._editingId ? "Edit schedule" : "New schedule"}</span>
        <button class="icon-btn" id="close-x"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      <div class="dialog-body" id="dialog-body"></div>
      <div class="dialog-footer">
        <div class="dialog-footer-left">
          ${this._editingId ? `<button class="btn btn-danger" id="del-btn">Delete</button>` : ""}
        </div>
        <div class="dialog-footer-right">
          <button class="btn btn-flat" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save</button>
        </div>
      </div>
    `;
    dlg.appendChild(card);
    card.querySelector("#close-x").addEventListener("click", () => this._closeEditor());
    card.querySelector("#cancel-btn").addEventListener("click", () => this._closeEditor());
    card.querySelector("#save-btn").addEventListener("click", () => this._saveEditor());
    const delBtn = card.querySelector("#del-btn");
    if (delBtn) delBtn.addEventListener("click", () => this._deleteFromEditor());

    this._renderEditorBody(card.querySelector("#dialog-body"));
  }

  _renderEditorBody(body) {
    const s = this._editing;
    body.innerHTML = `
      <div class="field-row">
        <div class="field field-grow">
          <label>Name</label>
          <input type="text" id="f-name" value="${escapeAttr(s.name)}" placeholder="e.g. Evening lights"/>
        </div>
        <div class="field" style="width:64px">
          <label>Color</label>
          <input type="color" id="f-color" value="${s.color || "#03a9f4"}"/>
        </div>
      </div>
      <div class="field-row">
        <div class="field field-grow" id="f-icon-wrap"></div>
        <div class="field">
          <label class="checkbox-label"><input type="checkbox" id="f-enabled" ${s.enabled ? "checked" : ""}/> Enabled</label>
        </div>
      </div>
      <div class="field-row">
        <div class="field field-grow" id="f-start-date-wrap"></div>
        <div class="field field-grow" id="f-end-date-wrap"></div>
      </div>
      <div class="field-row">
        <div class="field field-grow">
          <label>Skip dates (holidays, vacations, etc.)</label>
          <div class="skip-dates-chips" id="skip-dates-chips"></div>
          <div class="skip-dates-add">
            <input type="date" id="skip-date-input" class="skip-date-input"/>
            <button class="btn btn-flat" id="add-skip-date">+ Add</button>
          </div>
        </div>
      </div>
      <hr/>
      <div class="section-title">Timeslots</div>
      <div id="timeslots"></div>
      <button class="btn btn-flat" id="add-timeslot">+ Add timeslot</button>
    `;

    body.querySelector("#f-name").addEventListener("input", (e) => (s.name = e.target.value));
    body.querySelector("#f-color").addEventListener("input", (e) => (s.color = e.target.value));
    body.querySelector("#f-enabled").addEventListener("change", (e) => (s.enabled = e.target.checked));

    this._mountSelector(body.querySelector("#f-icon-wrap"), {
      selector: { icon: {} },
      value: s.icon,
      label: "Icon",
      onChange: (v) => (s.icon = v),
    });
    this._mountSelector(body.querySelector("#f-start-date-wrap"), {
      selector: { date: {} },
      value: s.start_date,
      label: "Active from (optional)",
      onChange: (v) => (s.start_date = v),
    });
    this._mountSelector(body.querySelector("#f-end-date-wrap"), {
      selector: { date: {} },
      value: s.end_date,
      label: "Active until (optional)",
      onChange: (v) => (s.end_date = v),
    });

    const renderSkipChips = () => {
      const chipsEl = body.querySelector("#skip-dates-chips");
      const dates = (s.skip_dates || []).slice().sort();
      chipsEl.innerHTML = dates.length
        ? dates.map((d) => `<span class="skip-chip">${d}<button class="skip-chip-x" data-date="${d}">×</button></span>`).join("")
        : `<span class="skip-dates-empty">No skip dates</span>`;
      chipsEl.querySelectorAll(".skip-chip-x").forEach((btn) =>
        btn.addEventListener("click", () => {
          s.skip_dates = (s.skip_dates || []).filter((d) => d !== btn.dataset.date);
          renderSkipChips();
        })
      );
    };
    renderSkipChips();
    body.querySelector("#add-skip-date").addEventListener("click", () => {
      const input = body.querySelector("#skip-date-input");
      if (!input.value) return;
      s.skip_dates = Array.from(new Set([...(s.skip_dates || []), input.value]));
      input.value = "";
      renderSkipChips();
    });

    const timeslotsEl = body.querySelector("#timeslots");
    s.timeslots.forEach((slot, idx) => timeslotsEl.appendChild(this._buildTimeslotCard(slot, idx)));

    body.querySelector("#add-timeslot").addEventListener("click", () => {
      s.timeslots.push(emptyTimeslot());
      this._renderEditorBody(body);
    });
  }

  _mountSelector(container, { selector, value, label, onChange, required }) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    if (label) {
      const l = document.createElement("label");
      l.textContent = label;
      wrap.appendChild(l);
    }
    const el = document.createElement("ha-selector");
    el.hass = this._hass;
    el.selector = selector;
    el.value = value;
    el.required = !!required;
    el.addEventListener("value-changed", (e) => {
      onChange(e.detail.value);
    });
    wrap.appendChild(el);
    container.appendChild(wrap);
    return el;
  }

  _buildTimeslotCard(slot, idx) {
    const card = document.createElement("div");
    card.className = "timeslot-card";
    const rerender = () => {
      const fresh = this._buildTimeslotCard(slot, idx);
      card.replaceWith(fresh);
    };

    const header = document.createElement("div");
    header.className = "timeslot-header";
    header.innerHTML = `<span>Timeslot ${idx + 1}</span>`;
    const headerActions = document.createElement("div");
    headerActions.className = "timeslot-header-actions";
    const rerenderTimeslotList = () => {
      const timeslotsEl = this.shadowRoot.querySelector("#timeslots");
      if (timeslotsEl) {
        timeslotsEl.innerHTML = "";
        this._editing.timeslots.forEach((sl, i) => timeslotsEl.appendChild(this._buildTimeslotCard(sl, i)));
      }
    };
    const dupBtn = document.createElement("button");
    dupBtn.className = "icon-btn";
    dupBtn.title = "Duplicate this timeslot";
    dupBtn.innerHTML = `<ha-icon icon="mdi:content-copy"></ha-icon>`;
    dupBtn.addEventListener("click", () => {
      const clone = JSON.parse(JSON.stringify(slot));
      clone.id = uuid();
      this._editing.timeslots.splice(idx + 1, 0, clone);
      rerenderTimeslotList();
    });
    headerActions.appendChild(dupBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.title = "Delete this timeslot";
    delBtn.innerHTML = `<ha-icon icon="mdi:delete"></ha-icon>`;
    delBtn.addEventListener("click", () => {
      this._editing.timeslots.splice(idx, 1);
      rerenderTimeslotList();
    });
    headerActions.appendChild(delBtn);
    header.appendChild(headerActions);
    card.appendChild(header);

    const recurrenceRow = document.createElement("div");
    recurrenceRow.className = "field-row";
    card.appendChild(recurrenceRow);
    this._mountSelector(recurrenceRow, {
      selector: {
        select: {
          mode: "list",
          options: [
            { value: "weekly", label: "Repeats weekly" },
            { value: "once", label: "One specific date" },
          ],
        },
      },
      value: slot.recurrence,
      label: "Repeats",
      onChange: (v) => {
        slot.recurrence = v;
        rerender();
      },
    });

    const recurrenceDetail = document.createElement("div");
    recurrenceDetail.className = "field-row";
    card.appendChild(recurrenceDetail);
    if (slot.recurrence === "once") {
      this._mountSelector(recurrenceDetail, {
        selector: { date: {} },
        value: slot.date,
        label: "Date",
        onChange: (v) => (slot.date = v),
      });
    } else {
      this._mountSelector(recurrenceDetail, {
        selector: {
          select: {
            multiple: true,
            mode: "list",
            options: WEEKDAYS.map((w) => ({ value: w, label: WEEKDAY_LABELS[w] })),
          },
        },
        value: slot.weekdays,
        label: "On these days",
        onChange: (v) => (slot.weekdays = v),
      });
    }

    card.appendChild(this._buildTimeSpecEditor("Starts", slot, "start", rerender));

    const hasEndRow = document.createElement("div");
    hasEndRow.className = "field-row";
    hasEndRow.innerHTML = `<label class="checkbox-label"><input type="checkbox" id="has-end" ${
      slot.end ? "checked" : ""
    }/> This is a time range (has an end time)</label>`;
    hasEndRow.querySelector("#has-end").addEventListener("change", (e) => {
      slot.end = e.target.checked ? { kind: "time", at: "22:00:00" } : null;
      if (!e.target.checked) slot.end_actions = [];
      rerender();
    });
    card.appendChild(hasEndRow);

    if (slot.end) {
      card.appendChild(this._buildTimeSpecEditor("Ends", slot, "end", rerender));
    }

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "field";
    card.appendChild(actionsWrap);
    this._mountSelector(actionsWrap, {
      selector: { action: {} },
      value: slot.actions,
      label: slot.end ? "Actions to run at start" : "Actions",
      onChange: (v) => (slot.actions = v),
    });

    if (slot.end) {
      const endActionsWrap = document.createElement("div");
      endActionsWrap.className = "field";
      card.appendChild(endActionsWrap);
      this._mountSelector(endActionsWrap, {
        selector: { action: {} },
        value: slot.end_actions,
        label: "Actions to run at end (optional)",
        onChange: (v) => (slot.end_actions = v),
      });
    }

    const onceRow = document.createElement("div");
    onceRow.className = "field-row";
    onceRow.innerHTML = `<label class="checkbox-label"><input type="checkbox" id="once" ${
      slot.once ? "checked" : ""
    }/> Disable this schedule automatically after it runs</label>`;
    onceRow.querySelector("#once").addEventListener("change", (e) => (slot.once = e.target.checked));
    card.appendChild(onceRow);

    return card;
  }

  _buildTimeSpecEditor(label, slot, key, rerender) {
    const wrap = document.createElement("div");
    wrap.className = "timespec";
    const title = document.createElement("div");
    title.className = "timespec-title";
    title.textContent = label;
    wrap.appendChild(title);

    const row = document.createElement("div");
    row.className = "field-row";
    wrap.appendChild(row);

    let spec = slot[key] || { kind: "time", at: "12:00:00" };
    slot[key] = spec;

    this._mountSelector(row, {
      selector: {
        select: {
          mode: "list",
          options: [
            { value: "time", label: "Fixed time" },
            { value: "sun", label: "Sunrise / sunset" },
          ],
        },
      },
      value: spec.kind,
      label: "Type",
      onChange: (v) => {
        slot[key] = v === "sun" ? { kind: "sun", event: "sunset", offset_minutes: 0 } : { kind: "time", at: "12:00:00" };
        rerender();
      },
    });

    if (spec.kind === "time") {
      this._mountSelector(row, {
        selector: { time: {} },
        value: spec.at,
        label: "Time",
        onChange: (v) => (spec.at = v),
      });
    } else {
      this._mountSelector(row, {
        selector: {
          select: {
            mode: "list",
            options: [
              { value: "sunrise", label: "Sunrise" },
              { value: "sunset", label: "Sunset" },
            ],
          },
        },
        value: spec.event,
        label: "Event",
        onChange: (v) => (spec.event = v),
      });
      this._mountSelector(row, {
        selector: { number: { mode: "box", step: 1, unit_of_measurement: "min" } },
        value: spec.offset_minutes || 0,
        label: "Offset (minutes, +/-)",
        onChange: (v) => (spec.offset_minutes = Number(v) || 0),
      });
    }

    return wrap;
  }

  _scheduleUpdatePayload(s) {
    return {
      name: (s.name || "").trim(),
      icon: s.icon,
      color: s.color,
      enabled: s.enabled,
      start_date: s.start_date || null,
      end_date: s.end_date || null,
      skip_dates: s.skip_dates || [],
      timeslots: s.timeslots,
    };
  }

  async _saveEditor() {
    const s = this._editing;
    if (!s.name || !s.name.trim()) {
      alert("Please give this schedule a name.");
      return;
    }
    const payload = this._scheduleUpdatePayload(s);
    if (this._editingId) {
      await this._hass.callWS({ type: "hassio_scheduler/update", schedule_id: this._editingId, schedule: payload });
    } else {
      await this._hass.callWS({ type: "hassio_scheduler/create", schedule: payload });
    }
    this._closeEditor();
    await this._loadSchedules();
  }

  async _deleteFromEditor() {
    if (!this._editingId) return;
    if (!confirm(`Delete "${this._editing.name}"? This cannot be undone.`)) return;
    await this._hass.callWS({ type: "hassio_scheduler/delete", schedule_id: this._editingId });
    this._closeEditor();
    await this._loadSchedules();
  }

  // ------------------------------------------------------------- popovers

  _openPopover(anchorEl, buildFn) {
    this._closePopover();
    const pop = document.createElement("div");
    pop.className = "popover";
    buildFn(pop);
    this.shadowRoot.querySelector(".root").appendChild(pop);
    const rect = anchorEl.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    const top = rect.bottom - hostRect.top + 6;
    let left = rect.left - hostRect.left;
    left = Math.max(8, Math.min(left, hostRect.width - 280));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    this._activePopover = pop;
    requestAnimationFrame(() => {
      document.addEventListener("click", this._onDocClickClosePopover, { capture: true });
    });
  }

  _closePopover() {
    if (this._activePopover) {
      this._activePopover.remove();
      this._activePopover = null;
    }
    document.removeEventListener("click", this._onDocClickClosePopover, { capture: true });
  }

  // -------------------------------------------------------------- heating

  async _loadHeatingProgramsAndRender() {
    await this._loadHeatingPrograms();
    if (this._tab === "heating") this._renderMain();
  }

  async _setHeatingEnabled(id, enabled) {
    await this._hass.callWS({ type: "hassio_scheduler/heating_set_enabled", program_id: id, enabled });
    await this._loadHeatingProgramsAndRender();
  }

  async _duplicateHeating(id) {
    await this._hass.callWS({ type: "hassio_scheduler/heating_duplicate", program_id: id });
    await this._loadHeatingProgramsAndRender();
  }

  async _deleteHeating(id) {
    const program = this._heatingPrograms.find((p) => p.id === id);
    if (!confirm(`Delete "${program ? program.name : "this heating program"}"? This cannot be undone.`)) return;
    await this._hass.callWS({ type: "hassio_scheduler/heating_delete", program_id: id });
    if (this._selectedHeatingId === id) this._selectedHeatingId = null;
    this._paintDraftGrid = null;
    await this._loadHeatingProgramsAndRender();
  }

  async _clearOverride(id) {
    await this._hass.callWS({ type: "hassio_scheduler/heating_clear_override", program_id: id });
    await this._loadHeatingProgramsAndRender();
  }

  _setHeatingSaveState(state) {
    this._heatingSaveState = state;
    const el = this.shadowRoot.querySelector("#heat-save-indicator");
    if (!el) return;
    el.textContent = state === "saving" ? "Saving…" : state === "saved" ? "✓ Saved" : "";
    el.className = `save-indicator save-indicator-${state}`;
    if (state === "saved") {
      clearTimeout(this._saveIndicatorTimer);
      this._saveIndicatorTimer = setTimeout(() => {
        if (el.isConnected) el.textContent = "";
      }, 1500);
    }
  }

  _heatingUpdatePayload(p) {
    return {
      name: p.name,
      icon: p.icon,
      color: p.color,
      enabled: p.enabled,
      climate_entities: p.climate_entities || [],
      hvac_mode: p.hvac_mode || null,
      presets: p.presets,
      default_preset_id: p.default_preset_id,
      grid: p.grid || {},
    };
  }

  async _saveHeatingGrid(programId, grid) {
    const program = this._heatingPrograms.find((p) => p.id === programId);
    if (!program) return;
    this._setHeatingSaveState("saving");
    const payload = { ...this._heatingUpdatePayload(program), grid };
    await this._hass.callWS({ type: "hassio_scheduler/heating_update", program_id: programId, program: payload });
    this._setHeatingSaveState("saved");
    await this._loadHeatingPrograms();
    if (this._tab === "heating") this._renderMain();
  }

  _saveHeatingGridDay(programId, day) {
    const program = this._heatingPrograms.find((p) => p.id === programId);
    if (!program || !this._paintDraftGrid || !this._paintDraftGrid[day]) return;
    const segments = compressCellsToSegments(this._paintDraftGrid[day]);
    const newGrid = { ...program.grid, [day]: segments };
    return this._saveHeatingGrid(programId, newGrid);
  }

  _copyDay(program, sourceDay, targetDays) {
    const sourceSegments = program.grid[sourceDay] || [];
    const newGrid = { ...program.grid };
    for (const d of targetDays) newGrid[d] = JSON.parse(JSON.stringify(sourceSegments));
    this._paintDraftGrid = null;
    return this._saveHeatingGrid(program.id, newGrid);
  }

  _clearDay(program, day) {
    const newGrid = { ...program.grid, [day]: [] };
    this._paintDraftGrid = null;
    return this._saveHeatingGrid(program.id, newGrid);
  }

  _openDayMenu(day, program, anchorEl) {
    this._openPopover(anchorEl, (pop) => {
      pop.innerHTML = `
        <div class="popover-title">${WEEKDAY_LABELS[day]}</div>
        <button class="popover-item" data-a="weekdays">Copy to Mon–Fri</button>
        <button class="popover-item" data-a="weekend">Copy to Sat–Sun</button>
        <button class="popover-item" data-a="all">Copy to all days</button>
        <button class="popover-item popover-danger" data-a="clear">Clear this day</button>
      `;
      pop.querySelector('[data-a="weekdays"]').addEventListener("click", () => {
        this._closePopover();
        this._copyDay(program, day, ["mon", "tue", "wed", "thu", "fri"]);
      });
      pop.querySelector('[data-a="weekend"]').addEventListener("click", () => {
        this._closePopover();
        this._copyDay(program, day, ["sat", "sun"]);
      });
      pop.querySelector('[data-a="all"]').addEventListener("click", () => {
        this._closePopover();
        this._copyDay(program, day, WEEKDAYS);
      });
      pop.querySelector('[data-a="clear"]').addEventListener("click", () => {
        this._closePopover();
        this._clearDay(program, day);
      });
    });
  }

  _openCustomTempPopover(anchorEl) {
    this._openPopover(anchorEl, (pop) => {
      pop.innerHTML = `
        <div class="popover-title">Custom temperature</div>
        <div class="popover-row">
          <input type="number" id="custom-temp" step="0.5" value="21" class="popover-input"/>
          <span>°</span>
        </div>
        <button class="btn btn-primary popover-confirm" id="custom-confirm">Use as brush</button>
      `;
      pop.querySelector("#custom-confirm").addEventListener("click", () => {
        const val = Number(pop.querySelector("#custom-temp").value);
        this._paintBrush = { kind: "custom", temperature: val };
        this._closePopover();
        this._renderMain();
      });
    });
  }

  _openBoostPopover(program, anchorEl) {
    this._openPopover(anchorEl, (pop) => {
      const defaultTemp = (findPreset(program, program.default_preset_id) || {}).temperature ?? 21;
      pop.innerHTML = `
        <div class="popover-title">Boost heating</div>
        <div class="popover-row">
          <input type="number" id="boost-temp" step="0.5" value="${defaultTemp}" class="popover-input"/><span>°</span>
        </div>
        <div class="popover-row popover-chips">
          <button class="chip" data-m="30">30m</button>
          <button class="chip chip-active" data-m="60">1h</button>
          <button class="chip" data-m="120">2h</button>
          <button class="chip" data-m="180">3h</button>
        </div>
        <button class="btn btn-primary popover-confirm" id="boost-confirm">Start boost</button>
      `;
      let minutes = 60;
      pop.querySelectorAll(".popover-chips .chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          pop.querySelectorAll(".popover-chips .chip").forEach((c) => c.classList.remove("chip-active"));
          chip.classList.add("chip-active");
          minutes = Number(chip.dataset.m);
        });
      });
      pop.querySelector("#boost-confirm").addEventListener("click", async () => {
        const temp = Number(pop.querySelector("#boost-temp").value);
        this._closePopover();
        await this._hass.callWS({
          type: "hassio_scheduler/heating_boost",
          program_id: program.id,
          temperature: temp,
          minutes,
        });
        await this._loadHeatingProgramsAndRender();
      });
    });
  }

  _openAwayPopover(program, anchorEl) {
    this._openPopover(anchorEl, (pop) => {
      const defaultTemp = (program.presets && program.presets[0] && program.presets[0].temperature) ?? 7;
      pop.innerHTML = `
        <div class="popover-title">Hold / Away</div>
        <div class="popover-row">
          <input type="number" id="away-temp" step="0.5" value="${defaultTemp}" class="popover-input"/><span>°</span>
        </div>
        <label class="checkbox-label"><input type="checkbox" id="away-indefinite" checked/> Hold until I cancel it</label>
        <div class="popover-row" id="away-until-row" style="display:none"></div>
        <button class="btn btn-primary popover-confirm" id="away-confirm">Start hold</button>
      `;
      const untilRow = pop.querySelector("#away-until-row");
      let untilMounted = false;
      pop.querySelector("#away-indefinite").addEventListener("change", (e) => {
        untilRow.style.display = e.target.checked ? "none" : "";
        if (!e.target.checked && !untilMounted) {
          untilMounted = true;
          this._mountSelector(untilRow, {
            selector: { datetime: {} },
            value: null,
            onChange: (v) => {
              pop.dataset.until = v || "";
            },
          });
        }
      });
      pop.querySelector("#away-confirm").addEventListener("click", async () => {
        const temp = Number(pop.querySelector("#away-temp").value);
        const indefinite = pop.querySelector("#away-indefinite").checked;
        const until = !indefinite && pop.dataset.until ? pop.dataset.until : null;
        this._closePopover();
        await this._hass.callWS({
          type: "hassio_scheduler/heating_set_override",
          program_id: program.id,
          temperature: temp,
          until,
        });
        await this._loadHeatingProgramsAndRender();
      });
    });
  }

  _renderHeatingTab() {
    const wrap = document.createElement("div");
    wrap.className = "heating-wrap";
    this._contentEl.appendChild(wrap);

    if (this._heatingLoading) {
      wrap.innerHTML = `<div class="empty">Loading heating programs…</div>`;
      return;
    }

    const chipsRow = document.createElement("div");
    chipsRow.className = "heating-chips";
    wrap.appendChild(chipsRow);
    this._renderHeatingProgramChips(chipsRow);

    if (!this._heatingPrograms.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = `
        <ha-icon icon="mdi:radiator"></ha-icon>
        <div>No heating programs yet.</div>
        <button class="btn btn-primary" id="empty-add">+ Create your first heating program</button>
      `;
      wrap.appendChild(empty);
      empty.querySelector("#empty-add").addEventListener("click", () => this._openHeatingEditor(null));
      return;
    }

    const program =
      this._heatingPrograms.find((p) => p.id === this._selectedHeatingId) || this._heatingPrograms[0];
    this._selectedHeatingId = program.id;
    this._renderHeatingProgramDetail(wrap, program);
  }

  _renderHeatingProgramChips(container) {
    container.innerHTML = "";
    this._heatingPrograms.forEach((program) => {
      const chip = document.createElement("button");
      chip.className = `heating-chip ${program.id === this._selectedHeatingId ? "heating-chip-active" : ""}`;
      chip.style.setProperty("--chip-color", program.color || "#ff7043");
      const hasTemp = program.target_temperature !== null && program.target_temperature !== undefined;
      const temp = hasTemp ? `${program.target_temperature}°` : "--";
      chip.innerHTML = `
        <ha-icon icon="${program.icon || "mdi:radiator"}"></ha-icon>
        <div class="heating-chip-main">
          <div class="heating-chip-name">${program.name}</div>
          <div class="heating-chip-temp">${program.enabled ? temp : "Off"}</div>
        </div>
      `;
      chip.addEventListener("click", () => {
        this._selectedHeatingId = program.id;
        this._paintDraftGrid = null;
        this._renderMain();
      });
      container.appendChild(chip);
    });
    const addChip = document.createElement("button");
    addChip.className = "heating-chip heating-chip-add";
    addChip.innerHTML = `<ha-icon icon="mdi:plus"></ha-icon><span>New</span>`;
    addChip.addEventListener("click", () => this._openHeatingEditor(null));
    container.appendChild(addChip);
  }

  _renderHeatingProgramDetail(container, program) {
    const card = document.createElement("div");
    card.className = "heating-detail";
    container.appendChild(card);

    const header = document.createElement("div");
    header.className = "heating-detail-header";
    header.innerHTML = `
      <div class="heating-detail-title">
        <ha-icon icon="${program.icon || "mdi:radiator"}" style="color:${program.color}"></ha-icon>
        <span>${program.name}</span>
      </div>
      <div class="heating-detail-actions">
        <button class="icon-btn" id="heat-dup" title="Duplicate"><ha-icon icon="mdi:content-copy"></ha-icon></button>
        <button class="icon-btn" id="heat-edit" title="Edit"><ha-icon icon="mdi:cog"></ha-icon></button>
        <button class="icon-btn" id="heat-del" title="Delete"><ha-icon icon="mdi:delete"></ha-icon></button>
        <label class="switch"><input type="checkbox" id="heat-enabled" ${program.enabled ? "checked" : ""}/><span class="slider"></span></label>
      </div>
    `;
    card.appendChild(header);
    header.querySelector("#heat-dup").addEventListener("click", () => this._duplicateHeating(program.id));
    header.querySelector("#heat-edit").addEventListener("click", () => this._openHeatingEditor(program.id));
    header.querySelector("#heat-del").addEventListener("click", () => this._deleteHeating(program.id));
    header
      .querySelector("#heat-enabled")
      .addEventListener("change", (e) => this._setHeatingEnabled(program.id, e.target.checked));

    this._renderHeatingStatusBanner(card, program);
    this._renderHeatingClimateReadouts(card, program);
    this._renderHeatingGrid(card, program);
  }

  _renderHeatingStatusBanner(container, program) {
    const banner = document.createElement("div");
    banner.className = "heating-banner";
    const override = program.override;
    if (!program.enabled) {
      banner.classList.add("heating-banner-off");
      banner.innerHTML = `<ha-icon icon="mdi:power-off"></ha-icon><span>Program disabled</span>`;
    } else if (override) {
      banner.classList.add(override.type === "boost" ? "heating-banner-boost" : "heating-banner-hold");
      const untilText = override.until
        ? `until ${new Date(override.until).toLocaleString(undefined, {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : "until cancelled";
      banner.innerHTML = `
        <ha-icon icon="${override.type === "boost" ? "mdi:fire" : "mdi:pause-circle"}"></ha-icon>
        <span>${override.type === "boost" ? "Boosting" : "Holding"} ${override.temperature}° ${untilText}</span>
        <button class="btn btn-flat" id="cancel-override">Cancel</button>
      `;
      banner.querySelector("#cancel-override").addEventListener("click", () => this._clearOverride(program.id));
    } else {
      const sourceLabel = program.source ? program.source.split(":").pop() : "";
      banner.innerHTML = `
        <ha-icon icon="mdi:calendar-check"></ha-icon>
        <span>Following schedule: <strong>${program.target_temperature ?? "--"}°</strong>${sourceLabel ? ` (${sourceLabel})` : ""}</span>
      `;
    }
    container.appendChild(banner);

    const actions = document.createElement("div");
    actions.className = "heating-quick-actions";
    actions.innerHTML = `
      <button class="btn btn-outline" id="boost-btn"><ha-icon icon="mdi:fire"></ha-icon> Boost</button>
      <button class="btn btn-outline" id="away-btn"><ha-icon icon="mdi:home-export-outline"></ha-icon> Hold / Away</button>
    `;
    container.appendChild(actions);
    actions.querySelector("#boost-btn").addEventListener("click", (e) => this._openBoostPopover(program, e.currentTarget));
    actions.querySelector("#away-btn").addEventListener("click", (e) => this._openAwayPopover(program, e.currentTarget));
  }

  _renderHeatingClimateReadouts(container, program) {
    if (!program.climate_entities || !program.climate_entities.length) return;
    const row = document.createElement("div");
    row.className = "heating-readouts";
    program.climate_entities.forEach((entityId) => {
      const state = this._hass.states[entityId];
      const chip = document.createElement("div");
      chip.className = "readout-chip";
      if (!state) {
        chip.innerHTML = `<ha-icon icon="mdi:alert-circle-outline"></ha-icon><span>${entityId} unavailable</span>`;
      } else {
        const cur = state.attributes.current_temperature;
        const target = state.attributes.temperature;
        const action = state.attributes.hvac_action;
        const heating = action === "heating";
        chip.innerHTML = `
          <ha-icon icon="mdi:thermometer" class="${heating ? "readout-pulse" : ""}"></ha-icon>
          <div class="readout-main">
            <div class="readout-name">${state.attributes.friendly_name || entityId}</div>
            <div class="readout-temps">${cur !== undefined ? `${cur}°` : "--"} → ${
          target !== undefined ? `${target}°` : "--"
        }${action ? ` · ${action}` : ""}</div>
          </div>
        `;
      }
      row.appendChild(chip);
    });
    container.appendChild(row);
  }

  _renderHeatingGrid(container, program) {
    if (!this._paintBrush || (this._paintBrush.kind === "preset" && !findPreset(program, this._paintBrush.presetId))) {
      this._paintBrush = program.presets.length
        ? { kind: "preset", presetId: program.presets[0].id }
        : { kind: "erase" };
    }

    const gridWrap = document.createElement("div");
    gridWrap.className = "heat-grid-wrap";
    container.appendChild(gridWrap);

    const palette = document.createElement("div");
    palette.className = "heat-palette";
    gridWrap.appendChild(palette);
    (program.presets || []).forEach((preset) => {
      const chip = document.createElement("button");
      const active = this._paintBrush.kind === "preset" && this._paintBrush.presetId === preset.id;
      chip.className = `paint-chip ${active ? "paint-chip-active" : ""}`;
      chip.style.setProperty("--paint-color", preset.color);
      chip.innerHTML = `<ha-icon icon="${preset.icon || "mdi:thermometer"}"></ha-icon><span>${preset.name} · ${preset.temperature}°</span>`;
      chip.addEventListener("click", () => {
        this._paintBrush = { kind: "preset", presetId: preset.id };
        this._renderMain();
      });
      palette.appendChild(chip);
    });
    const customChip = document.createElement("button");
    customChip.className = `paint-chip ${this._paintBrush.kind === "custom" ? "paint-chip-active" : ""}`;
    customChip.innerHTML = `<ha-icon icon="mdi:thermometer-plus"></ha-icon><span>${
      this._paintBrush.kind === "custom" ? `Custom (${this._paintBrush.temperature}°)` : "Custom…"
    }</span>`;
    customChip.addEventListener("click", (e) => this._openCustomTempPopover(e.currentTarget));
    palette.appendChild(customChip);
    const eraseChip = document.createElement("button");
    eraseChip.className = `paint-chip paint-chip-erase ${this._paintBrush.kind === "erase" ? "paint-chip-active" : ""}`;
    eraseChip.innerHTML = `<ha-icon icon="mdi:eraser"></ha-icon><span>Clear</span>`;
    eraseChip.addEventListener("click", () => {
      this._paintBrush = { kind: "erase" };
      this._renderMain();
    });
    palette.appendChild(eraseChip);
    const saveIndicator = document.createElement("span");
    saveIndicator.id = "heat-save-indicator";
    saveIndicator.className = "save-indicator";
    palette.appendChild(saveIndicator);

    const headerRow = document.createElement("div");
    headerRow.className = "heat-day-header-row";
    headerRow.innerHTML = `<div class="heat-header-spacer"></div>`;
    gridWrap.appendChild(headerRow);
    WEEKDAYS.forEach((day) => {
      const head = document.createElement("div");
      head.className = "heat-day-head";
      head.innerHTML = `<span>${WEEKDAY_LABELS[day].slice(0, 3)}</span>`;
      const menuBtn = document.createElement("button");
      menuBtn.className = "icon-btn heat-day-menu-btn";
      menuBtn.innerHTML = `<ha-icon icon="mdi:dots-vertical"></ha-icon>`;
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._openDayMenu(day, program, menuBtn);
      });
      head.appendChild(menuBtn);
      headerRow.appendChild(head);
    });

    const body = document.createElement("div");
    body.className = "heat-grid-body";
    body.style.gridTemplateColumns = `44px repeat(7, 1fr)`;
    body.style.gridTemplateRows = `repeat(${HEATING_ROWS}, ${HEATING_ROW_HEIGHT}px)`;
    gridWrap.appendChild(body);

    for (let h = 0; h < 24; h++) {
      const label = document.createElement("div");
      label.className = "heat-hour-label";
      label.style.gridRow = `${h * 2 + 1} / span 2`;
      label.style.gridColumn = "1";
      label.textContent = `${pad2(h)}:00`;
      body.appendChild(label);
    }

    const todayKey = weekdayKey(new Date());
    const nowIdx = Math.floor((new Date().getHours() * 60 + new Date().getMinutes()) / HEATING_SLOT_MINUTES);

    if (!this._paintDraftGrid) this._paintDraftGrid = {};
    this._heatingCellEls = {};
    WEEKDAYS.forEach((day, dayIdx) => {
      this._heatingCellEls[day] = [];
      const cells = this._paintDraftGrid[day] || expandDayToCells(program, day);
      this._paintDraftGrid[day] = cells;

      for (let idx = 0; idx < HEATING_ROWS; idx++) {
        const cellEl = document.createElement("div");
        cellEl.className = "heat-cell";
        if (day === todayKey && idx === nowIdx) cellEl.classList.add("heat-cell-now");
        cellEl.style.gridColumn = String(dayIdx + 2);
        cellEl.style.gridRow = String(idx + 1);
        this._applyCellStyle(cellEl, program, cells[idx]);
        cellEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this._startPaint(program, day, idx);
        });
        cellEl.addEventListener("mouseenter", (e) => {
          if (e.buttons & 1) this._paintCellAt(program, day, idx);
        });
        cellEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this._paintDraftGrid[day][idx] = null;
          this._applyCellStyle(cellEl, program, null);
          this._saveHeatingGridDay(program.id, day);
        });
        body.appendChild(cellEl);
        this._heatingCellEls[day].push(cellEl);
      }
    });

    const legend = document.createElement("div");
    legend.className = "heat-legend";
    (program.presets || []).forEach((preset) => {
      const item = document.createElement("span");
      item.className = "legend-item";
      item.innerHTML = `<span class="legend-swatch" style="background:${preset.color}"></span>${preset.name} (${preset.temperature}°)`;
      legend.appendChild(item);
    });
    const defaultPreset = findPreset(program, program.default_preset_id);
    const gapItem = document.createElement("span");
    gapItem.className = "legend-item";
    gapItem.innerHTML = `<span class="legend-swatch legend-swatch-gap" style="--gap-color:${
      defaultPreset ? defaultPreset.color : "#9e9e9e"
    }"></span>Unpainted → default${defaultPreset ? ` (${defaultPreset.name})` : ""}`;
    legend.appendChild(gapItem);
    gridWrap.appendChild(legend);
  }

  _applyCellStyle(cellEl, program, cell) {
    const info = cellDisplay(program, cell);
    cellEl.title = info.temperature !== null ? `${info.label} · ${info.temperature}°` : info.label;
    cellEl.classList.toggle("heat-cell-gap", info.isGap);
    if (info.isGap) {
      cellEl.style.background = "";
      cellEl.style.setProperty("--gap-color", info.color);
    } else {
      cellEl.style.removeProperty("--gap-color");
      cellEl.style.background = info.color;
    }
  }

  _startPaint(program, day, idx) {
    if (!this._paintBrush) return;
    this._paintDragging = true;
    this._paintDay = day;
    this._paintProgramId = program.id;
    if (!this._paintDraftGrid) this._paintDraftGrid = {};
    if (!this._paintDraftGrid[day]) this._paintDraftGrid[day] = expandDayToCells(program, day);
    this._applyBrushToCell(program, day, idx);
  }

  _paintCellAt(program, day, idx) {
    if (!this._paintDragging || this._paintDay !== day || this._paintProgramId !== program.id) return;
    this._applyBrushToCell(program, day, idx);
  }

  _applyBrushToCell(program, day, idx) {
    const brush = this._paintBrush;
    let cell;
    if (brush.kind === "erase") cell = null;
    else if (brush.kind === "custom") cell = { preset_id: null, temperature: brush.temperature };
    else cell = { preset_id: brush.presetId, temperature: null };
    this._paintDraftGrid[day][idx] = cell;
    const cellEl = this._heatingCellEls && this._heatingCellEls[day] && this._heatingCellEls[day][idx];
    if (cellEl) this._applyCellStyle(cellEl, program, cell);
  }

  _endPaint() {
    if (!this._paintDragging) return;
    this._paintDragging = false;
    const day = this._paintDay;
    const programId = this._paintProgramId;
    this._paintDay = null;
    this._paintProgramId = null;
    if (day && programId) this._saveHeatingGridDay(programId, day);
  }

  // ------------------------------------------------------ heating editor

  _openHeatingEditor(programId) {
    this._heatingEditingId = programId;
    if (programId) {
      const existing = this._heatingPrograms.find((p) => p.id === programId);
      this._heatingEditing = JSON.parse(JSON.stringify(existing));
    } else {
      this._heatingEditing = emptyHeatingProgram();
    }
    this._renderHeatingEditorDialog();
  }

  _closeHeatingEditor() {
    this._heatingEditing = null;
    this._heatingEditingId = null;
    const dlg = this.shadowRoot.querySelector("#heating-editor-dialog");
    if (dlg) dlg.remove();
  }

  _renderHeatingEditorDialog() {
    let dlg = this.shadowRoot.querySelector("#heating-editor-dialog");
    if (!dlg) {
      dlg = document.createElement("div");
      dlg.id = "heating-editor-dialog";
      dlg.className = "dialog-backdrop";
      this.shadowRoot.querySelector(".root").appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) this._closeHeatingEditor();
      });
    }
    dlg.innerHTML = "";
    const card = document.createElement("div");
    card.className = "dialog-card";
    card.innerHTML = `
      <div class="dialog-header">
        <span>${this._heatingEditingId ? "Edit heating program" : "New heating program"}</span>
        <button class="icon-btn" id="close-x"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>
      <div class="dialog-body" id="heating-dialog-body"></div>
      <div class="dialog-footer">
        <div class="dialog-footer-left">
          ${this._heatingEditingId ? `<button class="btn btn-danger" id="del-btn">Delete</button>` : ""}
        </div>
        <div class="dialog-footer-right">
          <button class="btn btn-flat" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save</button>
        </div>
      </div>
    `;
    dlg.appendChild(card);
    card.querySelector("#close-x").addEventListener("click", () => this._closeHeatingEditor());
    card.querySelector("#cancel-btn").addEventListener("click", () => this._closeHeatingEditor());
    card.querySelector("#save-btn").addEventListener("click", () => this._saveHeatingEditor());
    const delBtn = card.querySelector("#del-btn");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        const id = this._heatingEditingId;
        this._closeHeatingEditor();
        await this._deleteHeating(id);
      });
    }
    this._renderHeatingEditorBody(card.querySelector("#heating-dialog-body"));
  }

  _renderHeatingEditorBody(body) {
    const p = this._heatingEditing;
    body.innerHTML = `
      <div class="field-row">
        <div class="field field-grow">
          <label>Name</label>
          <input type="text" id="f-name" value="${escapeAttr(p.name)}" placeholder="e.g. Living room heating"/>
        </div>
        <div class="field" style="width:64px">
          <label>Color</label>
          <input type="color" id="f-color" value="${p.color || "#ff7043"}"/>
        </div>
      </div>
      <div class="field-row">
        <div class="field field-grow" id="f-icon-wrap"></div>
        <div class="field">
          <label class="checkbox-label"><input type="checkbox" id="f-enabled" ${p.enabled ? "checked" : ""}/> Enabled</label>
        </div>
      </div>
      <div class="field-row">
        <div class="field field-grow" id="f-climate-wrap"></div>
      </div>
      <div class="field-row">
        <div class="field field-grow" id="f-hvac-wrap"></div>
        <div class="field field-grow" id="f-default-wrap"></div>
      </div>
      <hr/>
      <div class="section-title">Presets</div>
      <div id="presets"></div>
      <button class="btn btn-flat" id="add-preset">+ Add preset</button>
    `;
    body.querySelector("#f-name").addEventListener("input", (e) => (p.name = e.target.value));
    body.querySelector("#f-color").addEventListener("input", (e) => (p.color = e.target.value));
    body.querySelector("#f-enabled").addEventListener("change", (e) => (p.enabled = e.target.checked));

    this._mountSelector(body.querySelector("#f-icon-wrap"), {
      selector: { icon: {} },
      value: p.icon,
      label: "Icon",
      onChange: (v) => (p.icon = v),
    });
    this._mountSelector(body.querySelector("#f-climate-wrap"), {
      selector: { entity: { domain: "climate", multiple: true } },
      value: p.climate_entities,
      label: "Climate entities to control",
      onChange: (v) => (p.climate_entities = v || []),
    });
    this._mountSelector(body.querySelector("#f-hvac-wrap"), {
      selector: {
        select: {
          mode: "list",
          options: [
            { value: "", label: "Don't change HVAC mode" },
            { value: "heat", label: "Heat" },
            { value: "auto", label: "Auto" },
            { value: "heat_cool", label: "Heat/Cool" },
          ],
        },
      },
      value: p.hvac_mode || "",
      label: "HVAC mode to set when applying",
      onChange: (v) => (p.hvac_mode = v || null),
    });
    this._mountSelector(body.querySelector("#f-default-wrap"), {
      selector: {
        select: { mode: "list", options: p.presets.map((pr) => ({ value: pr.id, label: pr.name })) },
      },
      value: p.default_preset_id,
      label: "Default preset (used for unpainted time)",
      onChange: (v) => (p.default_preset_id = v),
    });

    const presetsEl = body.querySelector("#presets");
    p.presets.forEach((preset) => presetsEl.appendChild(this._buildPresetRow(preset, body)));

    body.querySelector("#add-preset").addEventListener("click", () => {
      p.presets.push(emptyHeatingPreset("New preset", 20, "#90a4ae", "mdi:thermometer"));
      this._renderHeatingEditorBody(body);
    });
  }

  _buildPresetRow(preset, body) {
    const row = document.createElement("div");
    row.className = "preset-row";
    row.innerHTML = `
      <input type="color" class="preset-color" value="${preset.color}"/>
      <input type="text" class="preset-name" value="${escapeAttr(preset.name)}" placeholder="Name"/>
      <input type="number" class="preset-temp" value="${preset.temperature}" step="0.5"/>
      <span class="preset-deg">°</span>
      <button class="icon-btn preset-del" title="Remove"><ha-icon icon="mdi:delete"></ha-icon></button>
    `;
    row.querySelector(".preset-color").addEventListener("input", (e) => (preset.color = e.target.value));
    row.querySelector(".preset-name").addEventListener("input", (e) => (preset.name = e.target.value));
    row
      .querySelector(".preset-temp")
      .addEventListener("input", (e) => (preset.temperature = Number(e.target.value)));
    row.querySelector(".preset-del").addEventListener("click", () => {
      const p = this._heatingEditing;
      p.presets = p.presets.filter((pr) => pr.id !== preset.id);
      if (p.default_preset_id === preset.id) p.default_preset_id = p.presets[0] ? p.presets[0].id : null;
      this._renderHeatingEditorBody(body);
    });
    return row;
  }

  async _saveHeatingEditor() {
    const p = this._heatingEditing;
    if (!p.name || !p.name.trim()) {
      alert("Please give this heating program a name.");
      return;
    }
    if (!p.presets.length) {
      alert("Add at least one preset.");
      return;
    }
    p.name = p.name.trim();
    const payload = this._heatingUpdatePayload(p);
    if (this._heatingEditingId) {
      await this._hass.callWS({
        type: "hassio_scheduler/heating_update",
        program_id: this._heatingEditingId,
        program: payload,
      });
    } else {
      await this._hass.callWS({ type: "hassio_scheduler/heating_create", program: payload });
    }
    this._closeHeatingEditor();
    this._paintDraftGrid = null;
    await this._loadHeatingProgramsAndRender();
  }
}

function addDaysRange(start, count) {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

function escapeAttr(str) {
  return String(str || "").replace(/"/g, "&quot;");
}

const STYLES = `
  :host { display:block; height:100%; background: var(--primary-background-color); color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
  .root { position:relative; display:flex; flex-direction:column; height:100%; }
  .toolbar { display:flex; align-items:center; gap:24px; padding:0 16px; background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); flex-wrap:wrap; min-height:56px; }
  .toolbar-title { display:flex; align-items:center; gap:8px; font-size:20px; font-weight:400; }

  .ha-tabs { position:relative; display:flex; align-items:stretch; height:56px; }
  .ha-tab { position:relative; display:flex; align-items:center; gap:6px; background:transparent; border:none; color:inherit; opacity:0.75; padding:0 16px; font-size:13px; font-weight:500; letter-spacing:0.05em; text-transform:uppercase; cursor:pointer; }
  .ha-tab ha-icon { --mdc-icon-size:18px; }
  .ha-tab:hover { opacity:1; }
  .ha-tab-active { opacity:1; }
  .ha-tab-indicator { position:absolute; bottom:0; left:0; height:3px; background:#fff; border-radius:3px 3px 0 0; transition: transform 0.25s cubic-bezier(0.4,0,0.2,1), width 0.25s cubic-bezier(0.4,0,0.2,1); }
  .toolbar-spacer { flex:1; }

  .pause-banner { display:flex; align-items:center; gap:10px; padding:10px 16px; background: rgba(255,152,0,0.18); color: var(--primary-text-color); font-size:13px; border-bottom:1px solid var(--divider-color, #e0e0e0); }
  .pause-banner ha-icon { color:#ff9800; }
  .pause-banner button { margin-left:auto; }

  .subheader { display:flex; align-items:center; justify-content:flex-end; gap:16px; padding:8px 16px; background: var(--card-background-color, var(--primary-background-color)); border-bottom:1px solid var(--divider-color, #e0e0e0); flex-wrap:wrap; }
  .toolbar-nav { display:flex; align-items:center; gap:4px; flex:1; min-width:200px; }
  .nav-label { margin-left:8px; font-size:14px; opacity:0.8; white-space:nowrap; }
  .toolbar-views { display:flex; gap:4px; }
  .search { background: var(--secondary-background-color, rgba(127,127,127,0.15)); border:1px solid var(--divider-color, transparent); border-radius:16px; padding:6px 12px; color:inherit; width:100%; max-width:280px; }
  .content { flex:1; overflow:auto; padding:16px; box-sizing:border-box; }
  .empty { text-align:center; opacity:0.7; padding:48px 16px; display:flex; flex-direction:column; align-items:center; gap:12px; }
  .empty ha-icon { --mdc-icon-size:40px; opacity:0.5; }

  .btn { border:none; border-radius:20px; padding:8px 16px; font-size:14px; cursor:pointer; background:transparent; color:inherit; font-weight:500; }
  .btn-primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .btn-flat { background:transparent; color: var(--primary-color); }
  .btn-outline { background:transparent; color: var(--primary-text-color); border:1px solid var(--divider-color, #ccc); display:inline-flex; align-items:center; gap:6px; }
  .btn-outline:hover { background: rgba(127,127,127,0.1); }
  .btn-danger { background:transparent; color: var(--error-color, #db4437); }
  .icon-btn { background:transparent; border:none; cursor:pointer; color:inherit; padding:4px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
  .icon-btn:hover { background:rgba(127,127,127,0.15); }
  .chip { border:1px solid var(--divider-color, rgba(127,127,127,0.5)); background:transparent; color:inherit; padding:4px 12px; border-radius:16px; cursor:pointer; font-size:13px; }
  .chip-active { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }

  .cal-wrap { background: var(--card-background-color, #fff); border-radius:8px; overflow:hidden; border:1px solid var(--divider-color, #e0e0e0); }
  .cal-header { display:grid; border-bottom:1px solid var(--divider-color, #e0e0e0); position:sticky; top:0; background: var(--card-background-color, #fff); z-index:2; }
  .cal-gutter-head {}
  .cal-day-head { text-align:center; padding:8px 0; border-left:1px solid var(--divider-color, #e0e0e0); }
  .cal-day-head.today .cal-day-num { background: var(--primary-color); color:#fff; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; }
  .cal-day-name { font-size:12px; opacity:0.7; text-transform:uppercase; }
  .cal-day-num { font-size:16px; }
  .cal-body { display:grid; position:relative; overflow-y:auto; }
  .cal-gutter { position:relative; }
  .cal-hour-label { position:absolute; left:0; right:8px; text-align:right; font-size:11px; opacity:0.6; transform:translateY(-6px); }
  .cal-col { position:relative; border-left:1px solid var(--divider-color, #e0e0e0); background-image: repeating-linear-gradient(to bottom, transparent 0, transparent ${
    ROW_HEIGHT - 1
  }px, var(--divider-color, #eee) ${ROW_HEIGHT}px); }
  .cal-hour-slot { position:absolute; left:0; right:0; cursor:pointer; }
  .cal-hour-slot:hover { background: rgba(3,169,244,0.08); }
  .cal-now-line { position:absolute; left:0; right:0; height:2px; background: var(--error-color, #ff5252); z-index:3; pointer-events:none; }
  .cal-event { position:absolute; left:4px; right:4px; border-radius:4px; color:#fff; font-size:12px; padding:2px 6px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; display:flex; align-items:center; gap:4px; box-shadow:0 1px 2px rgba(0,0,0,0.3); z-index:1; }
  .cal-event ha-icon { --mdc-icon-size:14px; flex-shrink:0; }
  .cal-event-point { border-radius:10px; }

  .list-wrap { display:flex; flex-direction:column; gap:8px; }
  .list-row { display:flex; align-items:center; gap:12px; background: var(--card-background-color, #fff); border:1px solid var(--divider-color, #e0e0e0); border-radius:8px; padding:8px 12px; }
  .list-color { width:6px; align-self:stretch; border-radius:3px; }
  .list-main { flex:1; min-width:0; }
  .list-name { font-weight:500; }
  .list-sub { font-size:12px; opacity:0.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .list-next { font-size:13px; opacity:0.8; white-space:nowrap; }

  .switch { position:relative; display:inline-block; width:36px; height:20px; flex-shrink:0; }
  .switch input { opacity:0; width:0; height:0; }
  .switch .slider { position:absolute; cursor:pointer; inset:0; background-color:#ccc; transition:.2s; border-radius:20px; }
  .switch .slider:before { position:absolute; content:""; height:14px; width:14px; left:3px; bottom:3px; background-color:white; transition:.2s; border-radius:50%; }
  .switch input:checked + .slider { background-color: var(--primary-color); }
  .switch input:checked + .slider:before { transform: translateX(16px); }

  .dialog-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:10; padding:16px; box-sizing:border-box; }
  .dialog-card { background: var(--card-background-color, #fff); color: var(--primary-text-color); width:100%; max-width:640px; max-height:90vh; border-radius:8px; display:flex; flex-direction:column; overflow:hidden; }
  .dialog-header { display:flex; align-items:center; justify-content:space-between; padding:16px; font-size:18px; border-bottom:1px solid var(--divider-color, #e0e0e0); }
  .dialog-body { padding:16px; overflow-y:auto; flex:1; }
  .dialog-footer { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-top:1px solid var(--divider-color, #e0e0e0); }
  .dialog-footer-right { display:flex; gap:8px; }

  .field-row { display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
  .field { display:flex; flex-direction:column; gap:4px; flex:1; min-width:140px; }
  .field-grow { flex:2; }
  .field label { font-size:12px; opacity:0.7; }
  .field input[type="text"], .field input[type="color"] { font-size:14px; padding:8px; border-radius:4px; border:1px solid var(--divider-color, #ccc); background: var(--primary-background-color); color: inherit; }
  .checkbox-label { display:flex; align-items:center; gap:6px; font-size:14px; cursor:pointer; }

  hr { border:none; border-top:1px solid var(--divider-color, #e0e0e0); margin:16px 0; }
  .section-title { font-size:14px; font-weight:500; margin-bottom:8px; opacity:0.85; }

  .timeslot-card { border:1px solid var(--divider-color, #e0e0e0); border-radius:8px; padding:12px; margin-bottom:12px; }
  .timeslot-header { display:flex; align-items:center; justify-content:space-between; font-weight:500; margin-bottom:8px; }
  .timeslot-header-actions { display:flex; gap:2px; }
  .timespec { border-left:2px solid var(--divider-color, #e0e0e0); padding-left:8px; margin-bottom:8px; }
  .timespec-title { font-size:12px; opacity:0.7; margin-bottom:4px; }

  .skip-dates-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; min-height:24px; }
  .skip-chip { display:inline-flex; align-items:center; gap:4px; background: var(--secondary-background-color, rgba(127,127,127,0.12)); border-radius:12px; padding:3px 6px 3px 10px; font-size:12px; }
  .skip-chip-x { background:transparent; border:none; color:inherit; cursor:pointer; font-size:14px; line-height:1; padding:2px; opacity:0.6; }
  .skip-chip-x:hover { opacity:1; }
  .skip-dates-empty { font-size:12px; opacity:0.5; padding:3px 0; }
  .skip-dates-add { display:flex; gap:8px; align-items:center; }
  .skip-date-input { font-size:14px; padding:8px; border-radius:4px; border:1px solid var(--divider-color, #ccc); background: var(--primary-background-color); color:inherit; }

  /* ---------------------------------------------------------- popovers */
  .popover { position:absolute; z-index:20; background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius:8px; box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,0.3)); padding:12px; width:260px; box-sizing:border-box; border:1px solid var(--divider-color, #e0e0e0); }
  .popover-title { font-weight:500; margin-bottom:8px; font-size:14px; }
  .popover-row { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
  .popover-input { flex:1; font-size:16px; padding:8px; border-radius:4px; border:1px solid var(--divider-color, #ccc); background: var(--primary-background-color); color:inherit; }
  .popover-chips { flex-wrap:wrap; }
  .popover-confirm { width:100%; }
  .popover-item { display:flex; align-items:center; gap:8px; width:100%; text-align:left; background:transparent; border:none; color:inherit; padding:8px; border-radius:4px; cursor:pointer; font-size:13px; }
  .popover-item:hover { background: rgba(127,127,127,0.12); }
  .popover-danger { color: var(--error-color, #db4437); }

  /* --------------------------------------------------------- heating tab */
  .heating-wrap { display:flex; flex-direction:column; gap:16px; }
  .heating-chips { display:flex; gap:10px; overflow-x:auto; padding-bottom:4px; }
  .heating-chip { flex:0 0 auto; display:flex; align-items:center; gap:10px; background: var(--card-background-color, #fff); border:1px solid var(--divider-color, #e0e0e0); border-left:4px solid var(--chip-color, #ff7043); border-radius:8px; padding:8px 14px; cursor:pointer; color:inherit; min-width:150px; }
  .heating-chip ha-icon { color: var(--chip-color, #ff7043); }
  .heating-chip-active { box-shadow: 0 0 0 2px var(--chip-color, #ff7043) inset; }
  .heating-chip-main { display:flex; flex-direction:column; align-items:flex-start; }
  .heating-chip-name { font-size:13px; font-weight:500; }
  .heating-chip-temp { font-size:12px; opacity:0.7; }
  .heating-chip-add { border-style:dashed; justify-content:center; color: var(--primary-color); border-left-color: var(--divider-color, #e0e0e0); }

  .heating-detail { background: var(--card-background-color, #fff); border:1px solid var(--divider-color, #e0e0e0); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:12px; }
  .heating-detail-header { display:flex; align-items:center; justify-content:space-between; }
  .heating-detail-title { display:flex; align-items:center; gap:10px; font-size:18px; }
  .heating-detail-actions { display:flex; align-items:center; gap:4px; }

  .heating-banner { display:flex; align-items:center; gap:10px; background: var(--secondary-background-color, rgba(127,127,127,0.08)); border-radius:8px; padding:10px 14px; font-size:14px; }
  .heating-banner-off { opacity:0.7; }
  .heating-banner-boost { background: rgba(229,115,115,0.15); }
  .heating-banner-hold { background: rgba(129,167,196,0.18); }
  .heating-banner button { margin-left:auto; }

  .heating-quick-actions { display:flex; gap:8px; flex-wrap:wrap; }

  .heating-readouts { display:flex; gap:10px; flex-wrap:wrap; }
  .readout-chip { display:flex; align-items:center; gap:8px; background: var(--secondary-background-color, rgba(127,127,127,0.08)); border-radius:8px; padding:8px 12px; }
  .readout-name { font-size:12px; font-weight:500; }
  .readout-temps { font-size:12px; opacity:0.75; }
  @keyframes heat-pulse { 0%, 100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(1.15); } }
  .readout-pulse { color:#ff7043; animation: heat-pulse 1.4s ease-in-out infinite; }

  .heat-grid-wrap { background: var(--card-background-color, #fff); border:1px solid var(--divider-color, #e0e0e0); border-radius:12px; padding:16px; overflow-x:auto; }
  .heat-palette { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .paint-chip { display:flex; align-items:center; gap:6px; border:2px solid transparent; background: var(--secondary-background-color, rgba(127,127,127,0.1)); color:inherit; padding:6px 10px; border-radius:16px; cursor:pointer; font-size:12px; }
  .paint-chip ha-icon { --mdc-icon-size:16px; color: var(--paint-color, inherit); }
  .paint-chip-active { border-color: var(--paint-color, var(--primary-color)); background: rgba(127,127,127,0.18); box-shadow: 0 0 0 1px var(--paint-color, var(--primary-color)) inset; }
  .paint-chip-erase ha-icon { color: var(--secondary-text-color); }
  .save-indicator { font-size:12px; opacity:0.6; margin-left:auto; white-space:nowrap; }

  .heat-day-header-row { display:flex; min-width:520px; }
  .heat-header-spacer { width:44px; flex-shrink:0; }
  .heat-day-head { flex:1; display:flex; align-items:center; justify-content:center; gap:2px; font-size:12px; font-weight:500; text-transform:uppercase; opacity:0.8; padding:4px 0; }
  .heat-day-menu-btn { --mdc-icon-size:16px; opacity:0.5; }
  .heat-day-menu-btn:hover { opacity:1; }

  .heat-grid-body { display:grid; position:relative; min-width:520px; border-top:1px solid var(--divider-color, #eee); }
  .heat-hour-label { font-size:10px; opacity:0.55; text-align:right; padding-right:6px; line-height:1; transform:translateY(-5px); }
  .heat-cell { border-bottom:1px solid var(--divider-color, #f0f0f0); border-right:1px solid var(--divider-color, #f5f5f5); cursor:pointer; user-select:none; --gap-color: #9e9e9e; }
  .heat-cell:nth-child(even) { }
  .heat-cell-gap { background-image: repeating-linear-gradient(45deg, var(--gap-color) 0, var(--gap-color) 3px, transparent 3px, transparent 7px); opacity:0.55; }
  .heat-cell:hover { outline:2px solid var(--primary-color); outline-offset:-2px; z-index:1; position:relative; }
  .heat-cell-now { box-shadow: 0 0 0 2px var(--error-color, #ff5252) inset; }

  .heat-legend { display:flex; gap:16px; flex-wrap:wrap; margin-top:12px; font-size:12px; opacity:0.8; }
  .legend-item { display:flex; align-items:center; gap:6px; }
  .legend-swatch { width:12px; height:12px; border-radius:3px; display:inline-block; }
  .legend-swatch-gap { background-image: repeating-linear-gradient(45deg, var(--gap-color) 0, var(--gap-color) 2px, transparent 2px, transparent 4px); }

  .preset-row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .preset-row .preset-name { flex:1; font-size:14px; padding:8px; border-radius:4px; border:1px solid var(--divider-color, #ccc); background: var(--primary-background-color); color:inherit; }
  .preset-row .preset-temp { width:64px; font-size:14px; padding:8px; border-radius:4px; border:1px solid var(--divider-color, #ccc); background: var(--primary-background-color); color:inherit; }
  .preset-row .preset-color { width:32px; height:32px; padding:0; border:none; background:none; }

  @media (max-width: 700px) {
    .list-sub { display:none; }
    .nav-label { display:none; }
    .ha-tab span { display:none; }
  }
`;

customElements.define("hassio-scheduler-panel", HassioSchedulerPanel);
