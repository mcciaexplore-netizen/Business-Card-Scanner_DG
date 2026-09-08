"use client";

import { useEffect, useMemo, useState } from "react";
import { OTHER_PERSON_VALUE, PEOPLE } from "@/lib/people";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  bulk?: boolean;
}

const SAVED_PEOPLE_KEY = "aurascan_saved_people";

function normalizePersonName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 100);
}

export function ScannedBySelect({ value, onChange, disabled, bulk }: Props) {
  const [search, setSearch] = useState("");
  const [savedPeople, setSavedPeople] = useState<string[]>([]);
  const allPeople = useMemo(() => {
    const known = new Set(PEOPLE.map((person) => person.toLocaleLowerCase()));
    return [
      ...PEOPLE,
      ...savedPeople.filter((person) => {
        const key = person.toLocaleLowerCase();
        if (known.has(key)) return false;
        known.add(key);
        return true;
      }),
    ];
  }, [savedPeople]);
  const isOther = value === OTHER_PERSON_VALUE || Boolean(value && !allPeople.includes(value));
  const selectedValue = isOther ? OTHER_PERSON_VALUE : value;
  const visiblePeople = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    return allPeople.filter((person) => person.toLocaleLowerCase().includes(query));
  }, [allPeople, search]);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(SAVED_PEOPLE_KEY) || "[]");
      if (Array.isArray(stored)) {
        setSavedPeople(stored.filter((person): person is string => typeof person === "string"));
      }
    } catch {
      window.localStorage.removeItem(SAVED_PEOPLE_KEY);
    }
  }, []);

  const rememberCustomPerson = (rawName: string) => {
    const name = normalizePersonName(rawName);
    if (!name) {
      onChange(OTHER_PERSON_VALUE);
      return;
    }
    const existing = allPeople.find(
      (person) => person.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    const savedName = existing || name;
    onChange(savedName);
    if (existing) return;
    setSavedPeople((current) => {
      const updated = [...current, savedName];
      window.localStorage.setItem(SAVED_PEOPLE_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  const selectPerson = (person: string) => {
    onChange(person);
    setSearch("");
  };

  return (
    <div className="person-select">
      <label htmlFor="scanned-by">Scanned by <span className="optional-label">(optional)</span></label>
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search names"
        aria-label="Search scanner names"
        disabled={disabled}
      />
      {search.trim() && (
        <div className="person-search-results" role="listbox" aria-label="Matching scanner names">
          {visiblePeople.map((person) => (
            <button
              key={person}
              type="button"
              role="option"
              aria-selected={person === value}
              onClick={() => selectPerson(person)}
              disabled={disabled}
            >
              {person}
            </button>
          ))}
          {visiblePeople.length === 0 && <p>No matching saved name</p>}
        </div>
      )}
      <select
        id="scanned-by"
        value={selectedValue}
        onChange={(event) => selectPerson(event.target.value)}
        disabled={disabled}
        aria-describedby="scanned-by-help"
      >
        <option value="">Select your name</option>
        {allPeople.map((person) => (
          <option key={person} value={person}>{person}</option>
        ))}
        <option value={OTHER_PERSON_VALUE}>Other — enter your name</option>
      </select>

      {isOther && (
        <input
          type="text"
          value={value === OTHER_PERSON_VALUE ? "" : value}
          onChange={(event) => onChange(event.target.value || OTHER_PERSON_VALUE)}
          onBlur={(event) => rememberCustomPerson(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              rememberCustomPerson(event.currentTarget.value);
            }
          }}
          placeholder="Enter your full name"
          aria-label="Enter scanner name"
          maxLength={100}
          disabled={disabled}
          autoFocus
        />
      )}

      <p id="scanned-by-help">
        {bulk ? "This name will be saved with every card in this bulk upload. " : ""}
        Search and select a name, choose Other to save a new name, or leave this blank.
      </p>
    </div>
  );
}
