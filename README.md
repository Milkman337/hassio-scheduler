# Scheduler for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A fully-featured, UI-driven scheduler for Home Assistant. Manage everything from a dedicated **sidebar panel** with real **Day**, **Week** and **List** calendar views, plus a dedicated **Heating** tab with a paintable weekly temperature program — no YAML required.

Point-and-click a time slot to create a schedule, or open the editor to build something as simple as "turn a light on at 18:00" or as advanced as a full multi-step action sequence (delays, conditions, choose/repeat blocks — the exact same engine that powers automations).

## Features

### Scheduler

- 📅 **Day and Week hour-by-hour calendar views**, plus a filterable/sortable **List** view for management at a glance.
- 🖱️ Click-to-create: click any hour cell to start a new schedule pre-filled with that day and time.
- ⏰ Schedule by **fixed clock time** or relative to **sunrise/sunset** (with a +/- minute offset).
- 🔁 Repeat on chosen **weekdays**, or fire once on a **specific date**.
- ↔️ Optional **start + end** time ranges (e.g. "quiet hours 22:00 → 06:00"), including overnight ranges that cross midnight, with separate actions for when the range starts and ends.
- ⚙️ Actions use the same editor as the built-in Automation UI (`ha-selector` action editor) — call any service, target any entity/device/area, add delays, conditions, choose blocks, etc.
- 📆 Optional overall **active date window** (start/end date) per schedule, e.g. "only active during December".
- 🗓️ Run once and auto-disable, run manually with **Run now**, **duplicate**, **enable/disable**, or **delete** any schedule.

### Heating tab

A dedicated tab for the classic "weekly thermostat program" use case, built around one or more `climate` entities:

- 🎨 **Paint your weekly program** on a 7-day × 30-minute grid, Tado/Hive-style: pick a temperature preset as your brush, then click or click-drag across the grid to fill it in. Right-click a cell to clear it instantly.
- 🌡️ Fully custom **preset palette** per program (name, temperature, color, icon) — or paint a one-off **custom temperature** on any cell without needing a preset.
- 🧮 Unpainted time visibly falls back to a **default preset** (shown hatched), so the whole week is always covered.
- 📋 **Copy Monday to weekdays**, copy to the weekend, copy to every day, or clear a day - from a menu on each day header.
- 🔥 **Boost** a temperature for a set number of minutes (30m/1h/2h/3h/custom), or **Hold/Away** a temperature indefinitely or until a chosen date/time - both auto-revert to the schedule exactly on time, even across a Home Assistant restart.
- 📡 A live **status banner** shows what's active right now (schedule / boost / hold, with a cancel button), plus a **current vs. target** readout per climate entity with an animated flame while actively heating.
- 🏠 Drive **multiple climate entities** from a single program, with an optional HVAC mode to apply alongside the temperature.
- 🧩 Each program also becomes a `sensor` (current target temperature) and a `switch` (enable/disable) - and can be boosted/held from automations too.

### Platform

- 🧩 Every schedule and heating program becomes native Home Assistant entities - so they're automatable too.
- 🛎️ Fires `hassio_scheduler_triggered` / `hassio_scheduler_skipped` / `hassio_scheduler_heating_applied` events on the event bus.
- 🎛️ Native Home Assistant look and feel throughout - tabs, dialogs and pickers match the rest of the UI, in both light and dark themes.
- 💾 Everything is stored locally in Home Assistant's own storage — no cloud, no external dependencies.

## Installation

### Via HACS (recommended)

This repository is **not** in the default HACS store, so add it as a custom repository:

1. Open **HACS** in Home Assistant.
2. Click the **⋮** menu in the top-right corner → **Custom repositories**.
3. Add the repository URL:
   ```
   https://github.com/Milkman337/hassio-scheduler
   ```
4. Set the category to **Integration**, then click **Add**.
5. Find **Scheduler** in HACS and click **Download**.
6. Restart Home Assistant.
7. Go to **Settings → Devices & Services → Add Integration**, search for **Scheduler**, and add it.
8. A new **Scheduler** entry will appear in your sidebar.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Milkman337&repository=hassio-scheduler&category=integration)

### Manual installation

1. Download the latest release (or clone this repository).
2. Copy the `custom_components/hassio_scheduler` folder into your Home Assistant `config/custom_components/` directory, so you end up with `config/custom_components/hassio_scheduler/...`.
3. Restart Home Assistant.
4. Go to **Settings → Devices & Services → Add Integration**, search for **Scheduler**, and add it.

## Usage

Once added, open **Scheduler** in the sidebar. It has two tabs:

**Schedule**
- **Week / Day view** — click any empty hour cell to create a schedule at that day and time; click an existing block to edit it.
- **List view** — search, toggle, run now, duplicate, edit or delete any schedule; see when each one will next run.
- In the editor, add one or more **timeslots** to a schedule (e.g. weekdays at 07:00 *and* weekends at 09:00, all under one schedule), each with its own days/date, start (and optional end) time, and actions.

**Heating**
- Pick or create a heating program from the chip strip at the top, and select which `climate` entities it controls (via the ⚙️ editor).
- Choose a preset from the palette, then click or drag across the weekly grid to paint it in. Use each day header's **⋮** menu to copy a day to weekdays/weekend/everywhere, or clear it.
- Use **Boost** for a short temporary bump, or **Hold / Away** to override the schedule until you cancel it or until a chosen time.

## Services

| Service | Description |
|---|---|
| `hassio_scheduler.run_now` | Run a schedule's actions immediately, ignoring its configured time. |
| `hassio_scheduler.enable` | Enable a schedule. |
| `hassio_scheduler.disable` | Disable a schedule. |
| `hassio_scheduler.remove_schedule` | Permanently delete a schedule. |
| `hassio_scheduler.heating_boost` | Temporarily hold a temperature on a heating program for N minutes, then auto-revert. |
| `hassio_scheduler.heating_set_override` | Hold a temperature on a heating program indefinitely, or until a given time. |
| `hassio_scheduler.heating_clear_override` | Clear an active boost/hold override, returning to the schedule. |

## Events

| Event | Fired when |
|---|---|
| `hassio_scheduler_triggered` | A schedule's actions are about to run (start or end phase). |
| `hassio_scheduler_skipped` | A schedule fired with no actions configured. |
| `hassio_scheduler_heating_applied` | A heating program applied a new target temperature to its climate entities. |

## Contributing

Issues and pull requests are welcome at [github.com/Milkman337/hassio-scheduler](https://github.com/Milkman337/hassio-scheduler).

## License

[MIT](LICENSE)
