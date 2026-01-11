import { useState } from "react";
import type { ScheduleState, Weekday, DaySchedule } from "../types";

const weekdayOptions: { value: Weekday; label: string }[] = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

function weekdayLabel(w: Weekday) {
  return weekdayOptions.find(x => x.value === w)?.label ?? String(w);
}

export default function ScheduleBuilder(props: {
  schedule: ScheduleState;
  setSchedule: (s: ScheduleState) => void;
}) {
  const { schedule, setSchedule } = props;

  const [weekday, setWeekday] = useState<Weekday>(1);
  const [start, setStart] = useState("07:00");
  const [end, setEnd] = useState("17:00");

  function addSchedule() {
    if (!start || !end) return;

    const next: DaySchedule = { weekday, start, end };

    // replace if same weekday exists
    const without = schedule.items.filter(i => i.weekday !== weekday);
    const updated = [...without, next].sort((a, b) => a.weekday - b.weekday);

    setSchedule({ items: updated });
  }

  function removeDay(w: Weekday) {
    setSchedule({ items: schedule.items.filter(i => i.weekday !== w) });
  }

  function clearAll() {
    setSchedule({ items: [] });
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 space-y-4">
      <div className="font-semibold">1) Build Schedule</div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <div className="text-sm text-slate-300">Day</div>
          <select
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
            value={weekday}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setWeekday(Number(e.currentTarget.value) as Weekday)
            }
          >
            {weekdayOptions.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <div className="text-sm text-slate-300">Start</div>
          <input
            type="time"
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
            value={start}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setStart(e.currentTarget.value)
            }
          />
        </div>

        <div className="space-y-1">
          <div className="text-sm text-slate-300">End</div>
          <input
            type="time"
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2"
            value={end}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setEnd(e.currentTarget.value)
            }
          />
        </div>

        <button
          type="button"
          onClick={addSchedule}
          className="rounded-lg bg-lime-500/90 hover:bg-lime-500 text-slate-950 font-medium px-4 py-2"
        >
          Add schedule
        </button>

        <button
          type="button"
          onClick={clearAll}
          className="rounded-lg border border-slate-700 hover:bg-slate-800 px-4 py-2"
        >
          Clear
        </button>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <div className="text-sm font-medium mb-2">Selected schedule</div>

        {schedule.items.length === 0 ? (
          <div className="text-sm text-slate-400">
            No schedule added yet. Add at least one day to proceed.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {schedule.items.map(item => (
              <div
                key={item.weekday}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
              >
                <div className="text-sm">
                  <div className="font-medium">{weekdayLabel(item.weekday)}</div>
                  <div className="text-slate-300">
                    {item.start} – {item.end}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => removeDay(item.weekday)}
                  className="text-sm text-red-300 hover:text-red-200"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
