import { useId } from "react";
import { PUBLIC_HUMAN_EXPIRY_SECONDS } from "artifact-protocol";

export interface ExpiryPickerProps {
  readonly disabled: boolean;
  readonly options: readonly number[];
  readonly value: number;
  readonly onChange: (seconds: number) => void;
}

export const formatDuration = (seconds: number): string => {
  if (seconds < 3600) return `${seconds / 60} minutes`;
  if (seconds < 86_400) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = seconds / 86_400;
  return `${days} ${days === 1 ? "day" : "days"}`;
};

export const formatDurationList = (seconds: readonly number[]): string => {
  const durations = seconds.map(formatDuration);
  if (durations.length <= 1) return durations[0] ?? "";
  if (durations.length === 2) return `${durations[0]} or ${durations[1]}`;
  return `${durations.slice(0, -1).join(", ")}, or ${durations.at(-1)}`;
};

export const expiryOptionsForHumans = (
  allowed: readonly number[],
  deploymentMode: "public" | "private",
): readonly number[] => {
  if (deploymentMode === "private") return allowed;
  const recommended = PUBLIC_HUMAN_EXPIRY_SECONDS.filter((seconds) => allowed.includes(seconds));
  return recommended.length > 0 ? recommended : allowed;
};

export function ExpiryPicker({ disabled, options, value, onChange }: ExpiryPickerProps) {
  const name = useId();

  return (
    <fieldset className="expiry-picker">
      <legend>How long should the link work?</legend>
      <div className="expiry-picker__options">
        {options.map((seconds) => (
          <label key={seconds}>
            <input
              type="radio"
              name={name}
              value={seconds}
              checked={value === seconds}
              disabled={disabled}
              onChange={() => onChange(seconds)}
            />
            <span>{formatDuration(seconds)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
