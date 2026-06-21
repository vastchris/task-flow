export interface TaskTags {
  primary: string | null;
  secondary: string | null;
}

export interface ParsedTaskInput {
  name: string;
  storageName: string;
  editName: string;
  tags: TaskTags;
}

const EMPTY_TAGS: TaskTags = {
  primary: null,
  secondary: null,
};

export function parseTaskInput(input: string): ParsedTaskInput {
  const trimmed = input.trim();
  if (!trimmed) {
    return buildParsedTask("", EMPTY_TAGS);
  }

  const tokens = trimmed.split(/\s+/);
  const tags: string[] = [];
  let index = 0;
  while (index < tokens.length && tags.length < 2 && isTagToken(tokens[index])) {
    tags.push(tokens[index]);
    index += 1;
  }

  const name = tokens.slice(index).join(" ").trim();
  return buildParsedTask(name, {
    primary: tags[0] ?? null,
    secondary: tags[1] ?? null,
  });
}

export function parseStoredTaskName(storedName: string): ParsedTaskInput {
  const trimmed = storedName.trim();
  if (!trimmed) {
    return buildParsedTask("", EMPTY_TAGS);
  }

  const tokens = trimmed.split(/\s+/);
  const tags: string[] = [];
  let index = tokens.length - 1;
  while (index >= 0 && tags.length < 2 && isTagToken(tokens[index])) {
    tags.unshift(tokens[index]);
    index -= 1;
  }

  const name = tokens.slice(0, index + 1).join(" ").trim();
  return buildParsedTask(name, {
    primary: tags[0] ?? null,
    secondary: tags[1] ?? null,
  });
}

export function formatTaskInputForEdit(storedName: string): string {
  return parseStoredTaskName(storedName).editName;
}

export function getTaskDisplayName(storedName: string): string {
  return parseStoredTaskName(storedName).name;
}

export function tagsEqual(left: TaskTags | undefined, right: TaskTags): boolean {
  return (left?.primary ?? null) === right.primary
    && (left?.secondary ?? null) === right.secondary;
}

export function replaceStoredTaskTag(
  storedName: string,
  level: "primary" | "secondary",
  nextTag: string
): ParsedTaskInput {
  const parsed = parseStoredTaskName(storedName);
  const tags = {
    primary: level === "primary" ? nextTag : parsed.tags.primary,
    secondary: level === "secondary" ? nextTag : parsed.tags.secondary,
  };
  return buildParsedTask(parsed.name, tags);
}

export function isValidSingleTag(tagName: string): boolean {
  return isTagToken(tagName);
}

function buildParsedTask(name: string, tags: TaskTags): ParsedTaskInput {
  const tagList = [tags.primary, tags.secondary].filter((tag): tag is string => Boolean(tag));
  return {
    name,
    storageName: [name, ...tagList].filter(Boolean).join(" ").trim(),
    editName: [...tagList, name].filter(Boolean).join(" ").trim(),
    tags,
  };
}

function isTagToken(token: string | undefined): token is string {
  return typeof token === "string" && /^#[^\s#]+$/.test(token);
}
