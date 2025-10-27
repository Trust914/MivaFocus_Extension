/**
 * MivaFocus Background Service Worker
 * Handles extension lifecycle and ensures content script is loaded
 * Updated to support department-only onboarding
 */

// Install event
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[MivaFocus Background] Extension installed/updated:', details.reason);
  
  if (details.reason === 'install') {
    console.log('[MivaFocus Background] First install - Welcome!');
    
    // Set default settings for new installations
    chrome.storage.sync.set({
      userSettings: {
        department: null,
        filterEnabled: false,
        filterLevel: null,
        filterSemester: null,
        showStats: true,
        onboardingComplete: false
      }
    });
    
    // Optionally open popup or welcome page
    // chrome.action.openPopup();
  } else if (details.reason === 'update') {
    console.log('[MivaFocus Background] Updated to version', chrome.runtime.getManifest().version);
    
    // Handle migration for existing users if needed
    migrateSettings();
  }
});

// Migrate settings from old version (if needed)
async function migrateSettings() {
  try {
    const result = await chrome.storage.sync.get('userSettings');
    
    if (result.userSettings) {
      const settings = result.userSettings;
      
      // Migration logic: if user had currentLevel but no filterLevel, migrate it
      if (settings.currentLevel && !settings.filterLevel) {
        settings.filterLevel = settings.currentLevel;
        delete settings.currentLevel;
        
        await chrome.storage.sync.set({ userSettings: settings });
        console.log('[MivaFocus Background] Settings migrated successfully');
      }
    }
  } catch (error) {
    console.error('[MivaFocus Background] Migration error:', error);
  }
}

// Listen for tab updates to inject/verify content script
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only proceed if the page has finished loading
  if (changeInfo.status !== 'complete') return;
  
  // Check if it's an LMS page
  if (tab.url && tab.url.includes('lms.miva.university')) {
    console.log('[MivaFocus Background] LMS page loaded:', tabId);
    
    // Verify content script is responding
    chrome.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[MivaFocus Background] Content script not responding in tab', tabId);
        // Content script should auto-inject via manifest
      } else {
        console.log('[MivaFocus Background] Content script active in tab', tabId);
      }
    });
  }
});

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[MivaFocus Background] Message received:', request.action);
  
  (async () => {
    try {
      switch (request.action) {
        case 'ping':
          sendResponse({ status: 'pong' });
          break;
          
        case 'checkContentScript':
          // Check if content script is loaded in a specific tab
          if (request.tabId) {
            chrome.tabs.sendMessage(request.tabId, { action: 'ping' }, (response) => {
              sendResponse({ loaded: !chrome.runtime.lastError });
            });
          } else {
            sendResponse({ error: 'No tabId provided' });
          }
          break;
          
        case 'getActiveLMSTabs':
          // Return list of active LMS tabs
          const tabs = await chrome.tabs.query({});
          const lmsTabs = tabs.filter(tab => 
            tab.url && 
            tab.url.includes('lms.miva.university') &&
            tab.status === 'complete'
          );
          sendResponse({ tabs: lmsTabs, count: lmsTabs.length });
          break;
          
        case 'reloadContentScripts':
          // Force reload content scripts in all LMS tabs
          const allTabs = await chrome.tabs.query({});
          const targetTabs = allTabs.filter(tab => 
            tab.url && tab.url.includes('lms.miva.university')
          );
          
          for (const tab of targetTabs) {
            try {
              await chrome.tabs.reload(tab.id);
              console.log('[MivaFocus Background] Reloaded tab', tab.id);
            } catch (error) {
              console.error('[MivaFocus Background] Failed to reload tab', tab.id, error);
            }
          }
          
          sendResponse({ success: true, reloadedCount: targetTabs.length });
          break;
          
        case 'getUserSettings':
          // Get current user settings
          const result = await chrome.storage.sync.get('userSettings');
          sendResponse({ settings: result.userSettings || null });
          break;
          
        case 'clearAllData':
          // Clear all extension data (for debugging/reset)
          await chrome.storage.sync.clear();
          await chrome.storage.local.clear();
          console.log('[MivaFocus Background] All data cleared');
          sendResponse({ success: true });
          break;
          
        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (error) {
      console.error('[MivaFocus Background] Error handling message:', error);
      sendResponse({ error: error.message });
    }
  })();
  
  return true; // Keep message channel open for async response
});

// Handle extension icon click (optional - for debugging)
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[MivaFocus Background] Extension icon clicked');
  
  // Check if user has completed onboarding
  const result = await chrome.storage.sync.get('userSettings');
  const settings = result.userSettings;
  
  if (!settings || !settings.department) {
    console.log('[MivaFocus Background] User needs onboarding');
  } else {
    console.log('[MivaFocus Background] User configured with department:', settings.department);
  }
});

// Monitor storage changes (for debugging)
chrome.storage.onChanged.addListener((changes, areaName) => {
  console.log('[MivaFocus Background] Storage changed in', areaName);
  
  if (changes.userSettings) {
    console.log('[MivaFocus Background] User settings updated:', 
      changes.userSettings.newValue);
  }
  
  if (changes.departmentCourses) {
    console.log('[MivaFocus Background] Department courses updated for:', 
      changes.departmentCourses.newValue?.department);
  }
});

// Alarm for periodic cache cleanup (optional)
chrome.alarms.create('cleanupCache', { periodInMinutes: 60 * 24 }); // Daily

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cleanupCache') {
    console.log('[MivaFocus Background] Running cache cleanup...');
    
    try {
      const cached = await chrome.storage.local.get('courseDBCache');
      const now = Date.now();
      const cacheExpiry = 7 * 24 * 60 * 60 * 1000; // 7 days
      
      if (cached.courseDBCache && cached.courseDBCache.timestamp) {
        const age = now - cached.courseDBCache.timestamp;
        
        if (age > cacheExpiry) {
          await chrome.storage.local.remove('courseDBCache');
          console.log('[MivaFocus Background] Old cache removed');
        } else {
          console.log('[MivaFocus Background] Cache is still fresh');
        }
      }
    } catch (error) {
      console.error('[MivaFocus Background] Cache cleanup error:', error);
    }
  }
});

console.log('[MivaFocus Background] Service worker initialized and ready');
console.log('[MivaFocus Background] Version:', chrome.runtime.getManifest().version);