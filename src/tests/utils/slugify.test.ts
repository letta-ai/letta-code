import { slugify } from "../../utils/slugify";

test("slugify lowercases and hyphenates", () => {
  expect(slugify("Hello World Test")).toBe("hello-world-test");
});

test("slugify removes accents and punctuation", () => {
  expect(slugify("Crème brûlée!")).toBe("creme-brulee");
});