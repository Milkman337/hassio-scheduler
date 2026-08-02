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
    timeslots: [emptyTimeslot()],
  };
}

class HassioSchedulerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._schedules = [];
    this._loading = true;
    this._view = "week";
    this._cursor = startOfWeek(new Date());
    this._dayCursor = new Date();
    this._editing = null;
    this._editingId = null;
    this._filter = "";
    this._initialized = false;
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
      this._refreshTimer = setInterval(() => this._loadSchedules(), REFRESH_INTERVAL_MS);
    }
  }

  disconnectedCallback() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  async _init() {
    this._injectBaseStyles();
    this._renderShell();
    await this._loadSchedules();
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
    this._renderMain();
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
        <div class="toolbar-nav" id="nav"></div>
        <div class="toolbar-views" id="view-switch"></div>
        <button class="btn btn-primary" id="add-btn">+ New schedule</button>
      </div>
      <div class="content" id="content"></div>
    `;
    this.shadowRoot.appendChild(root);
    this._contentEl = root.querySelector("#content");
    root.querySelector("#add-btn").addEventListener("click", () => this._openEditor(null));
    this._renderViewSwitch(root.querySelector("#view-switch"));
    this._renderNav(root.querySelector("#nav"));
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
    this._renderViewSwitch(root.querySelector("#view-switch"));
    this._renderNav(root.querySelector("#nav"));
    this._renderMain();
  }

  _renderMain() {
    if (!this._contentEl) return;
    this._contentEl.innerHTML = "";
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
        <button class="icon-btn" title="Duplicate" id="dup-${schedule.id}"><ha-icon icon="mdi:content-copy"></ha-icon></button>
        <button class="icon-btn" title="Edit" id="edit-${schedule.id}"><ha-icon icon="mdi:pencil"></ha-icon></button>
        <button class="icon-btn" title="Delete" id="del-${schedule.id}"><ha-icon icon="mdi:delete"></ha-icon></button>
      `;
      row.querySelector(`#toggle-${schedule.id}`).addEventListener("change", (e) =>
        this._setEnabled(schedule.id, e.target.checked)
      );
      row.querySelector(`#run-${schedule.id}`).addEventListener("click", () => this._runNow(schedule.id));
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
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.innerHTML = `<ha-icon icon="mdi:delete"></ha-icon>`;
    delBtn.addEventListener("click", () => {
      this._editing.timeslots.splice(idx, 1);
      const timeslotsEl = this.shadowRoot.querySelector("#timeslots");
      if (timeslotsEl) {
        timeslotsEl.innerHTML = "";
        this._editing.timeslots.forEach((sl, i) => timeslotsEl.appendChild(this._buildTimeslotCard(sl, i)));
      }
    });
    header.appendChild(delBtn);
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

  async _saveEditor() {
    const s = this._editing;
    if (!s.name || !s.name.trim()) {
      alert("Please give this schedule a name.");
      return;
    }
    const payload = {
      name: s.name.trim(),
      icon: s.icon,
      color: s.color,
      enabled: s.enabled,
      start_date: s.start_date || null,
      end_date: s.end_date || null,
      timeslots: s.timeslots,
    };
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
}

function addDaysRange(start, count) {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

function escapeAttr(str) {
  return String(str || "").replace(/"/g, "&quot;");
}

const STYLES = `
  :host { display:block; height:100%; background: var(--primary-background-color); color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
  .root { display:flex; flex-direction:column; height:100%; }
  .toolbar { display:flex; align-items:center; gap:16px; padding:8px 16px; background: var(--app-header-background-color, var(--primary-color)); color: var(--app-header-text-color, #fff); flex-wrap:wrap; }
  .toolbar-title { display:flex; align-items:center; gap:8px; font-size:20px; font-weight:400; margin-right:8px; }
  .toolbar-nav { display:flex; align-items:center; gap:4px; flex:1; min-width:200px; }
  .nav-label { margin-left:8px; font-size:14px; opacity:0.9; white-space:nowrap; }
  .toolbar-views { display:flex; gap:4px; }
  .search { background:rgba(255,255,255,0.15); border:none; border-radius:16px; padding:6px 12px; color:inherit; width:100%; max-width:280px; }
  .search::placeholder { color: rgba(255,255,255,0.75); }
  .content { flex:1; overflow:auto; padding:16px; box-sizing:border-box; }
  .empty { text-align:center; opacity:0.7; padding:48px 16px; }

  .btn { border:none; border-radius:4px; padding:8px 16px; font-size:14px; cursor:pointer; background:transparent; color:inherit; }
  .btn-primary { background: var(--mdc-theme-secondary, #ff9800); color:#fff; }
  .btn-flat { background:transparent; color:inherit; }
  .btn-danger { background:transparent; color: var(--error-color, #db4437); }
  .icon-btn { background:transparent; border:none; cursor:pointer; color:inherit; padding:4px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
  .icon-btn:hover { background:rgba(127,127,127,0.15); }
  .chip { border:1px solid rgba(255,255,255,0.5); background:transparent; color:inherit; padding:4px 12px; border-radius:16px; cursor:pointer; font-size:13px; }
  .chip-active { background:rgba(255,255,255,0.25); }

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
  .timespec { border-left:2px solid var(--divider-color, #e0e0e0); padding-left:8px; margin-bottom:8px; }
  .timespec-title { font-size:12px; opacity:0.7; margin-bottom:4px; }

  @media (max-width: 700px) {
    .list-sub { display:none; }
    .nav-label { display:none; }
  }
`;

customElements.define("hassio-scheduler-panel", HassioSchedulerPanel);
