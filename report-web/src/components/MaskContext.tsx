import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { loadMaskPreference, saveMaskPreference } from "../utils/format";

interface MaskContextValue {
  masked: boolean;
  toggleMask: () => void;
}

const MaskContext = createContext<MaskContextValue>({ masked: false, toggleMask: () => {} });

export function MaskProvider({ children }: { children: React.ReactNode }) {
  const [masked, setMasked] = useState<boolean>(() => loadMaskPreference());

  const toggleMask = useCallback(() => {
    setMasked((prev) => {
      saveMaskPreference(!prev);
      return !prev;
    });
  }, []);

  const value = useMemo(() => ({ masked, toggleMask }), [masked, toggleMask]);
  return <MaskContext.Provider value={value}>{children}</MaskContext.Provider>;
}

export function useMask(): MaskContextValue {
  return useContext(MaskContext);
}
