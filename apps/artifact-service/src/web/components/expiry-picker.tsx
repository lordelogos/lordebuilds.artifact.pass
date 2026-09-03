import { useId } from "react";

export interface ExpiryPickerProps {
  readonly disabled: boolean;
  readonly options: readonly number[];
  readonly value: number;
  readonly onChange: (seconds: number) => void;
}

export const formatDuration = (seconds: number): string => {
  if (seconds < 3600) return `${seconds / 60} minutes`;
  if (seconds === 3600) return "1 hour";
  return `${seconds / 3600} hours`;
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
