import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { usePageTitle } from "../utils/pageTitle";

function Probe({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

describe("usePageTitle", () => {
  it("sets document.title on mount and restores on unmount", () => {
    document.title = "初始标题";
    const { unmount } = render(<Probe title="趋势" />);
    expect(document.title).toBe("趋势 | Personal Treasury");
    unmount();
    expect(document.title).toBe("初始标题");
  });
});
