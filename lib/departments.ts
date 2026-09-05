// Starter list shared by the dropdown and server validation. Replace these
// values with the organization's official department names when available.
export const DEPARTMENTS: readonly string[] = [
  "Leadership / Management",
  "Business Development",
  "Sales",
  "Marketing",
  "Operations",
  "Finance & Accounts",
  "Human Resources",
  "Information Technology",
  "Administration",
  "Procurement",
  "Legal & Compliance",
  "Customer Support",
];

export function readDepartment(formData: FormData): string {
  const value = formData.get("department");
  if (value === null || value === "") return "";
  if (typeof value !== "string" || !DEPARTMENTS.includes(value)) {
    throw new Error("Choose a department from the dropdown.");
  }
  return value;
}
