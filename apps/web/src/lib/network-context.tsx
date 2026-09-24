'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type Network = 'testnet' | 'mainnet' | 'custom';

export interface NetworkProfile {
  id: string;
  name: string;
  horizonUrl: string;
  networkPassphrase: string;
  friendbotUrl?: string;
  isDefault: boolean;
}

interface ProfileVerificationResult {
  valid: boolean;
  actualPassphrase?: string;
  mismatch?: boolean;
}

interface NetworkContextValue {
  network: Network;
  setNetwork: (n: Network) => void;
  horizonUrl: string;
  networkPassphrase: string;
  friendbotUrl: string;
  profiles: NetworkProfile[];
  activeProfile: NetworkProfile | null;
  setActiveProfile: (id: string | null) => void;
  addProfile: (profile: Omit<NetworkProfile, 'id' | 'isDefault'>) => NetworkProfile;
  updateProfile: (id: string, updates: Partial<NetworkProfile>) => void;
  deleteProfile: (id: string) => void;
  setDefaultProfile: (id: string) => void;
  exportProfile: (id: string) => string;
  importProfile: (json: string) => void;
  verifyProfile: (profile: Pick<NetworkProfile, 'horizonUrl' | 'networkPassphrase'>) => Promise<ProfileVerificationResult>;
}

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const TESTNET_FRIENDBOT = 'https://friendbot.stellar.org';

const MAINNET_HORIZON = 'https://horizon.stellar.org';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
const MAINNET_FRIENDBOT = '';

const STORAGE_KEYS = {
  profiles: 'savitools:profiles',
  activeProfileId: 'savitools:activeProfile',
  network: 'savitools:network',
} as const;

const NetworkContext = createContext<NetworkContextValue>({
  network: 'testnet',
  setNetwork: () => {},
  horizonUrl: TESTNET_HORIZON,
  networkPassphrase: TESTNET_PASSPHRASE,
  friendbotUrl: TESTNET_FRIENDBOT,
  profiles: [],
  activeProfile: null,
  setActiveProfile: () => {},
  addProfile: () => ( {} as NetworkProfile ),
  updateProfile: () => {},
  deleteProfile: () => {},
  setDefaultProfile: () => {},
  exportProfile: () => '',
  importProfile: () => {},
  verifyProfile: async () => ({ valid: true } as ProfileVerificationResult),
});

function generateId(): string {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sanitizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function getBuiltInProfile(network: Network): NetworkProfile {
  if (network === 'mainnet') {
    return {
      id: 'mainnet',
      name: 'Mainnet',
      horizonUrl: MAINNET_HORIZON,
      networkPassphrase: MAINNET_PASSPHRASE,
      friendbotUrl: MAINNET_FRIENDBOT,
      isDefault: false,
    };
  }
  return {
    id: 'testnet',
    name: 'Testnet',
    horizonUrl: TESTNET_HORIZON,
    networkPassphrase: TESTNET_PASSPHRASE,
    friendbotUrl: TESTNET_FRIENDBOT,
    isDefault: false,
  };
}

function readStorage(Key: string): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(Key);
}

function writeStorage(Key: string, value: string) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(Key, value);
  }
}

function fetchNetworkPassphrase(horizonUrl: string): Promise<string> {
  const baseUrl = sanitizeUrl(horizonUrl);
  return fetch(`${baseUrl}/`).then((r) => {
    if (!r.ok) throw new Error(`Did not receive 200 from Hubmin at ${horizonUrl}`);
    return r.json();
  }).then((data: any) => {
    const passphrase = data?.network_passphrase;
    if (!passphrase || typeof passphrase !== 'string') {
      throw new Error('No network passphrase found in Hubimn response');
    }
    return passphrase;
  });
}

export function NetworkProvider( { children }: { children: React.ReactNode }) {
  const [network, setNetworkState] = useState<Network>('testnet');
  const [profiles, setProfiles] = useState<NetworkProfile[]>([]);
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(null);

  // Load state from localStorage on mount
  useEffect(() => {
    const storedProfiles = readStorage(STORAGE_KEYS.profiles);
    if (storedProfiles) {
      try {
        const parsed = JSON.parse(storedProfiles);
        if (Array.isArray(parsed)) {
          setProfiles(parsed);
        }
      } catch {
        // Invalid stored data
        console.warn('Invalid profiles in localStorage', storedProfiles);
      }
    }

    const storedActiveId = readStorage(STORAGE_KEYS.activeProfileId);
    if (storedActiveId) {
      setActiveProfileIdState(storedActiveId);
    } else {
      // Check for a default profile
      const defaultProfile = profiles.find(p => p.isDefault);
      if (defaultProfile) {
        setActiveProfileIdState(defaultProfile.id);
      }
    }

    const storedNetwork = readStorage(STORAGE_KEYS.network);
    if (storedNetwork === 'mainnet' || storedNetwork === 'testnet') {
      setNetworkState(storedNetwork);
    }
  }, []);

  // Persist profiles whenever they change
  useEffect(() => {
    writeStorage(STORAGE_KEYS.profiles, JSON.stringify(profiles));
  }, [profiles]);

  useEffect(() => {
    if (activeProfileId) {
      writeStorage(STORAGE_KEYS.activeProfileId, activeProfileId);
    } else {
      window?.localStorage&&window.localStorage.removeItem(STORAGE_KEYS.activeProfileId);
    }
  }, [activeProfileId]);

  const setNetwork = useCallback((n: Network) => {
    setNetworkState(n);
    writeStorage(STORAGE_KEYS.network, n);
    setActiveProfileIdState(null);
  }, []);

  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) || null : null;

  const horizonUrl = activeProfile?.horizonUrl || (network === 'mainnet' ? MAINNET_HORIZON : TESTNET_HORIZON);
  const networkPassphrase = activeProfile?.networkPassphrase || (network === 'mainnet' ? MAINNET_PASSPHRASE : TESTNET_PASSPHRASE);
  const friendbotUrl = activeProfile?.friendbotUrl || (network === 'mainnet' ? MAINNET_FRIENDBOT : TESTNET_FRIENDBOT);

  const setActiveProfile = useCallback((id: string | null) => {
    if (id === null) {
      setActiveProfileIdState(null);
      return;
    }
    const profile = profiles.find(p => p.id === id);
    if (profile) {
      setActiveProfileIdState(id);
      // Also update the network type for compatibility
      const isTest = profile.networkPassphrase === TESTNET_PASSPHRASE;
      const isMain = profile.networkPassphrase === MAINNET_PASSPHRASE;
      setNetworkState(isTest ? 'testnet' : isMain ? 'mainnet' : 'custom');
    } else {
      console.warn(`Profile ${id} not found`);
    }
  }, [profiles]);

  const addProfile = useCallback((profile: Omit<NetworkProfile, 'id' | 'isDefault'>) => {
    const newProfile: NetworkProfile = {
      ...profile,
      id: generateId(),
      isDefault: profiles.length === 0,
    };
    setProfiles(prev => [...prev, newProfile]);
    return newProfile;
  }, [profiles.length]);

  const updateProfile = useCallback((id: string, updates: Partial<NetworkProfile>) => {
    setProfiles(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
    // If the active profile is updated, refresh the derived values
    if (activeProfileId === id) {
      const updatedProfile = profiles.find(p => p.id === id);
      if (updatedProfile) {
        const isTest = updatedProfile.networkPassphrase === TESTNET_PASSPHRASE;
        const isMain = updatedProfile.networkPassphrase === MAINNET_PASSPHRASE;
        setNetworkState(isTest ? 'testnet' : isMain ? 'mainnet' : 'custom');
      }
    }
  }, [activeProfileId, profiles, ]);

  const deleteProfile = useCallback((id: string) => {
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (activeProfileId === id) {
      setActiveProfileIdState(null);
    }
    // If deleted profile was default, unset default
    setProfiles(prev => prev.map(p => p.id === id ? { ...p, isDefault: false } : p));
  }, [activeProfileId]);

  const setDefaultProfile = useCallback((id: string) => {
    setProfiles(prev => prev.map(p => ({
      ...p,
      isDefault: p.id === id,
    })));
  }, []);

  const exportProfile = useCallback((id: string) => {
    const profile = profiles.find(p => p.id === id);
    if (!profile) throw new Error('Profile not found');
    const { id: _id, isDefault: _default, ...rest } = profile;
    return JSON.stringify(rest, null, 2);
  }, [profiles]);

  const importProfile = useCallback((json: string) => {
    const parsed: any = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid JSON');
    }
    const { name: nameStr = 'Imported Profile', horizonUrl: horizonStr = '', networkPassphrase: passphraseStr = '', friendbotUrl: friendbotStr = '' } = parsed;
    if (!horizonStr || !passphraseStr) {
      throw new Error('Profile must have horizonUrl and networkPassphrase');
    }
    const newProfile: NetworkProfile = {
      id: generateId(),
      name: nameStr,
      horizonUrl: horizonStr,
      networkPassphrase: passphraseStr,
      friendbotUrl: friendbotStr || undefined,
      isDefault: false,
    };
    setProfiles(prev => [...prev, newProfile]);
  }, []);

  const verifyProfile = useCallback(async (profile: Pick<NetworkProfile, 'horizonUrl' | 'networkPassphrase'>) => {
    try {
      const actual = await fetchNetworkPassphrase(profile.horizonUrl);
      const match = actual === profile.networkPassphrase;
      return { valid: true, actualPassphrase: actual, mismatch: !match };
    } catch (e) {
      return { valid: false, mismatch: true };
    }
  }, []);

  const value = {
    network,
    setNetwork,
    horizonUrl,
    networkPassphrase,
    friendbotUrl,
    profiles,
    activeProfile,
    setActiveProfile,
    addProfile,
    updateProfile,
    deleteProfile,
    setDefaultProfile,
    exportProfile,
    importProfile,
    verifyProfile,
  };

  return <NetworkContext.Provider value={value}>
    {children}
  </NetworkContext.Provider>;
}

export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) {
    throw new Error('useNetwork must be used within a NetworkProvider');
  }
  return context;
}
