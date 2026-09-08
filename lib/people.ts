export const PEOPLE: readonly string[] = [
  "Aniruddha Brahma",
  "Chintamani Shrotri",
  "Ganesh Mate",
  "Mangesh Kulkarni",
  "Neeraj Thakur",
  "Nikhil Jain",
  "Prashant Jogalekar",
  "Rajnikant Gaikwad",
  "S H Kopardekar",
  "Satavisha Natu",
  "Shantanu Jagtap",
  "Sudhanwa Kopardekar",
];

export const OTHER_PERSON_VALUE = "__other_person__";
const MAX_PERSON_NAME_LENGTH = 100;

export function readScannedBy(formData: FormData): string {
  const value = formData.get("scanned_by");
  if (value === null || value === "" || value === OTHER_PERSON_VALUE) return "";
  if (typeof value !== "string") return "";

  const name = value.trim().replace(/\s+/g, " ");
  if (!name) return "";
  if (name.length > MAX_PERSON_NAME_LENGTH) {
    throw new Error(`The scanner name must be ${MAX_PERSON_NAME_LENGTH} characters or fewer.`);
  }
  return name;
}
