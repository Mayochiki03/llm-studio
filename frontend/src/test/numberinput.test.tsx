// ทดสอบช่องกรอกตัวเลข: ลบจนว่างแล้วพิมพ์ใหม่ต้องไม่กลายเป็น 01000
import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NumberInput } from "../components/ui";

function Host({ min, max }: { min?: number; max?: number }) {
  const [v, setV] = useState(500);
  return (
    <div>
      <NumberInput value={v} onChange={setV} min={min} max={max} />
      <span data-testid="v">{v}</span>
    </div>
  );
}

describe("NumberInput", () => {
  it("ลบจนว่างแล้วพิมพ์ 1000 ได้ ไม่เป็น 01000", () => {
    render(<Host />);
    const el = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "" } });
    expect(el.value).toBe("");
    fireEvent.change(el, { target: { value: "1" } });
    fireEvent.change(el, { target: { value: "1000" } });
    expect(el.value).toBe("1000");
    expect(screen.getByTestId("v").textContent).toBe("1000");
  });
  it("ออกจากช่องตอนว่าง คืนค่าเดิม", () => {
    render(<Host />);
    const el = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "" } });
    fireEvent.blur(el);
    expect(el.value).toBe("500");
  });
  it("เกินช่วง min/max ถูกปรับตอน blur", () => {
    render(<Host min={1} max={2000} />);
    const el = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(el, { target: { value: "9999" } });
    fireEvent.blur(el);
    expect(el.value).toBe("2000");
    expect(screen.getByTestId("v").textContent).toBe("2000");
  });
});
