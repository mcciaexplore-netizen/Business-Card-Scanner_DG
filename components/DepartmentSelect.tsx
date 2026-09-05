"use client";

import { DEPARTMENTS } from "@/lib/departments";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  bulk?: boolean;
}

export function DepartmentSelect({ value, onChange, disabled, bulk }: Props) {
  return (
    <div className="department-select">
      <label htmlFor="card-department">Card belongs to — department</label>
      <select
        id="card-department"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby="department-help"
      >
        <option value="">Not assigned</option>
        {DEPARTMENTS.map((department) => (
          <option key={department} value={department}>{department}</option>
        ))}
      </select>
      <p id="department-help">
        {bulk ? "Applies to every card in this bulk upload. " : ""}
        Choose the department receiving the card.
      </p>
    </div>
  );
}
