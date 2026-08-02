# Scheduler for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A fully-featured, UI-driven scheduler for Home Assistant. Manage everything from a dedicated **sidebar panel** with real **Day**, **Week** and **List** calendar views — no YAML required.

Point-and-click a time slot to create a schedule, or open the editor to build something as simple as "turn a light on at 18:00" or as advanced as a full multi-step action sequence (delays, conditions, choose/repeat blocks — the exact same engine that powers automations).

## Features

- 📅 **Day and Week hour-by-hour calendar views**, plus a filterable/sortable **List** view for management at a glance.
- 🖱️ Click-to-create: click any hour cell to start a new schedule pre-filled with that day and time.
- ⏰ Schedule by **fixed clock time** or relative to **sunrise/sunset** (with a +/- minute offset).
- 🔁 Repeat on chosen **weekdays**, or fire once on a **specific date**.
- ↔️ Optional **start + end** time ranges (e.g. "quiet hours 22:00 → 06:00"), including overnight ranges that cross midnight, with separate actions for when the range starts and ends.
- ⚙️ Actions use the same editor as the built-in Automation UI (`ha-selector` action editor) — call any service, target any entity/device/area, add delays, conditions, choose blocks, etc.
- 📆 Optional overall **active date window** (start/end date) per schedule, e.g. "only active during December".
- 🗓️ Run once and auto-disable, run manually with **Run now**, **duplicate**, **enable/disable**, or **delete** any schedule.
- 🧩 Every schedule also becomes native Home Assistant entities: a `sensor` showing its next run time and a `switch` to enable/disable it — so it's automatable too.
- 🛎️ Fires `hassio_scheduler_triggered` / `hassio_scheduler_skipped` events on the event bus, and exposes `hassio_scheduler.run_now`, `.enable`, `.disable` and `.remove_schedule` services.
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

Once added, open **Scheduler** in the sidebar:

- **Week / Day view** — click any empty hour cell to create a schedule at that day and time; click an existing block to edit it.
- **List view** — search, toggle, run now, duplicate, edit or delete any schedule; see when each one will next run.
- In the editor, add one or more **timeslots** to a schedule (e.g. weekdays at 07:00 *and* weekends at 09:00, all under one schedule), each with its own days/date, start (and optional end) time, and actions.

## Services

| Service | Description |
|---|---|
| `hassio_scheduler.run_now` | Run a schedule's actions immediately, ignoring its configured time. |
| `hassio_scheduler.enable` | Enable a schedule. |
| `hassio_scheduler.disable` | Disable a schedule. |
| `hassio_scheduler.remove_schedule` | Permanently delete a schedule. |

## Events

| Event | Fired when |
|---|---|
| `hassio_scheduler_triggered` | A schedule's actions are about to run (start or end phase). |
| `hassio_scheduler_skipped` | A schedule fired with no actions configured. |

## Contributing

Issues and pull requests are welcome at [github.com/Milkman337/hassio-scheduler](https://github.com/Milkman337/hassio-scheduler).

## License

[MIT](LICENSE)
