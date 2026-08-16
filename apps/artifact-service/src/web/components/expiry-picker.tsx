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
  return (
    <label className="field-label">
      <span>Link expires after</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      >
        {options.map((seconds) => (
          <option key={seconds} value={seconds}>
            {formatDuration(seconds)}
          </option>
        ))}
      </select>
    </label>
  );
}
