class MivaFocusFilter {
  constructor() {
    this.userSettings = null;
    this.departmentCourses = null;
    this.fullDatabase = null;
    this.lmsCourses = [];
    
    this.normalizedDbCourses = new Map();
    this.dbCodesSet = new Set();
    this.dbCoursesByCode = new Map();
    this.dbTitlesByFilter = new Map();
    
    this.stats = { total: 0, visible: 0, hidden: 0 };
    this.isFiltering = false;
    this.initialized = false;
    this.debounceTimer = null;
    this.observer = null;
    
    this.patterns = {
      courseCode: /(?:MIVA-?)?([A-Z]{3})\s*[/-]?\s*(\d{3})/gi,
      numericSequence: /\b\d+\b|\bi{1,3}v?\b|\biv\b|\bv\b|\bvi{1,3}\b|\bix\b|\bx\b/gi,
      romanNumeral: /^i{1,3}v?$|^iv$|^v$|^vi{1,3}$|^ix$|^x$/i,
      normalize: /[^\w\s]/g,
    };
    
    this.romanMap = {
      'i': '1', 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5',
      'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10'
    };
  }

  async init() {
    if (this.initialized) return;
    
    console.log('[MivaFocus] Initializing...');
    
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      (async () => {
        try {
          switch (request.action) {
            case 'updateSettings':
              await this.handleSettingsUpdate(request.settings);
              sendResponse({ success: true });
              break;
            case 'resetSettings':
              await this.handleReset();
              sendResponse({ success: true });
              break;
            case 'getStats':
              sendResponse(this.stats);
              break;
            default:
              sendResponse({ success: false, error: 'Unknown action' });
          }
        } catch (error) {
          console.error('[MivaFocus] Message handler error:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;
    });

    try {
      await this.loadUserSettings();
      
      if (!this.userSettings.department) {
        console.log('[MivaFocus] User needs to complete onboarding');
        this.showOnboardingPrompt();
        return;
      }
      
      await this.loadDepartmentCourses();
      
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
      }
      
      this.injectUI();
      this.extractLMSCourses();
      this.observeDOMChanges();
      
      if (this.userSettings.filterEnabled) {
        await this.applyFilter();
      }
      
      this.initialized = true;
      console.log('[MivaFocus] Initialized successfully');
    } catch (error) {
      console.error('[MivaFocus] Initialization error:', error);
    }
  }

  async loadUserSettings() {
    const defaults = {
      department: null,
      filterEnabled: false,
      filterLevel: null,
      filterSemester: null,
      showStats: false,
      onboardingComplete: false
    };

    const result = await chrome.storage.sync.get('userSettings');
    this.userSettings = { ...defaults, ...result.userSettings };
  }

  async saveUserSettings() {
    await chrome.storage.sync.set({ userSettings: this.userSettings });
  }

  async loadDepartmentCourses() {
    try {
      const result = await chrome.storage.local.get('departmentCourses');
      
      if (result.departmentCourses && result.departmentCourses.department === this.userSettings.department) {
        this.departmentCourses = result.departmentCourses;
        await this.loadFullDatabase();
        this.buildOptimizedLookups();
        console.log('[MivaFocus] Department courses loaded from storage');
      } else if (this.userSettings.department) {
        console.log('[MivaFocus] Fetching full course database...');
        const fullDB = await this.fetchFullDatabase();
        
        if (fullDB?.faculties) {
          this.fullDatabase = fullDB;
          
          let found = false;
          for (const facultyData of Object.values(fullDB.faculties)) {
            if (facultyData.departments?.[this.userSettings.department]) {
              this.departmentCourses = {
                department: this.userSettings.department,
                courses: facultyData.departments[this.userSettings.department].courses
              };
              await chrome.storage.local.set({ departmentCourses: this.departmentCourses });
              this.buildOptimizedLookups();
              console.log('[MivaFocus] Department courses extracted and stored');
              found = true;
              break;
            }
          }
          if (!found) {
            console.warn('[MivaFocus] Department not found:', this.userSettings.department);
            this.departmentCourses = null;
          }
        } else {
          console.warn('[MivaFocus] No courses found for department:', this.userSettings.department);
          this.departmentCourses = null;
        }
      } else {
        console.log('[MivaFocus] No department set, skipping course load');
        this.departmentCourses = null;
      }
    } catch (error) {
      console.error('[MivaFocus] Failed to load department courses:', error);
      this.departmentCourses = null;
    }
  }

  async loadFullDatabase() {
    if (this.fullDatabase) return;
    
    try {
      const result = await chrome.storage.local.get('fullDatabase');
      if (result.fullDatabase) {
        this.fullDatabase = result.fullDatabase;
        console.log('[MivaFocus] Full database loaded from storage');
      } else {
        console.log('[MivaFocus] Fetching full database for cross-department matching...');
        this.fullDatabase = await this.fetchFullDatabase();
        if (this.fullDatabase) {
          await chrome.storage.local.set({ fullDatabase: this.fullDatabase });
        }
      }
    } catch (error) {
      console.error('[MivaFocus] Failed to load full database:', error);
    }
  }

  async fetchFullDatabase() {
    const githubRawUrl = 'https://raw.githubusercontent.com/trust914/MivaFocus_Scraper/master/miva_courses_full.json';
    try {
      const response = await fetch(githubRawUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Failed to fetch database`);
      }
      return await response.json();
    } catch (error) {
      console.error('[MivaFocus] Database fetch error:', error);
      return null;
    }
  }

  buildOptimizedLookups() {
    this.normalizedDbCourses.clear();
    this.dbCodesSet.clear();
    this.dbCoursesByCode.clear();
    this.dbTitlesByFilter.clear();
    
    if (!this.fullDatabase?.faculties) return;
    
    const startTime = performance.now();
    let courseCount = 0;
    
    for (const facultyData of Object.values(this.fullDatabase.faculties)) {
      if (!facultyData.departments) continue;
      
      for (const [deptCode, deptData] of Object.entries(facultyData.departments)) {
        if (!deptData.courses) continue;
        
        for (const [levelKey, levelData] of Object.entries(deptData.courses)) {
          if (!levelData || typeof levelData !== 'object') continue;
          
          for (const [semesterKey, semesterCourses] of Object.entries(levelData)) {
            if (!Array.isArray(semesterCourses)) continue;
            
            for (const course of semesterCourses) {
              if (!course?.title) continue;
              
              courseCount++;
              const normalized = this.normalizeTitle(course.title);
              const courseCodes = this.extractAllCourseCodes(course.title);
              
              const courseData = {
                original: course.title,
                normalized,
                codes: courseCodes,
                level: levelKey,
                semester: semesterKey,
                department: deptCode
              };
              
              this.normalizedDbCourses.set(course.title, courseData);
              
              for (const code of courseCodes) {
                this.dbCodesSet.add(code);
                
                if (!this.dbCoursesByCode.has(code)) {
                  this.dbCoursesByCode.set(code, []);
                }
                this.dbCoursesByCode.get(code).push(courseData);
              }
            }
          }
        }
      }
    }
    
    const elapsed = performance.now() - startTime;
    console.log(`[MivaFocus] Built optimized lookups for ${courseCount} courses across all departments in ${elapsed.toFixed(2)}ms`);
    console.log(`[MivaFocus] Total unique course codes: ${this.dbCodesSet.size}`);
  }

  extractAllCourseCodes(title) {
    const codes = new Set();
    this.patterns.courseCode.lastIndex = 0;
    
    let match;
    while ((match = this.patterns.courseCode.exec(title)) !== null) {
      const dept = match[1].toUpperCase();
      const num = match[2];
      const code = `${dept}${num}`.toLowerCase();
      codes.add(code);
    }
    
    return Array.from(codes);
  }

  getFilteredCourses() {
    const { filterLevel, filterSemester } = this.userSettings;
    const cacheKey = `${filterLevel || 'all'}_${filterSemester || 'all'}`;
    
    if (this.dbTitlesByFilter.has(cacheKey)) {
      return this.dbTitlesByFilter.get(cacheKey);
    }
    
    const coursesToMatch = [];
    
    if (!this.departmentCourses?.courses) {
      return coursesToMatch;
    }
    
    if (filterLevel && filterSemester) {
      const levelKey = `${filterLevel}_Level`;
      const courses = this.departmentCourses.courses[levelKey]?.[filterSemester];
      if (courses) coursesToMatch.push(...courses);
    } else if (filterLevel) {
      const levelKey = `${filterLevel}_Level`;
      const levelData = this.departmentCourses.courses[levelKey];
      if (levelData) {
        for (const semesterCourses of Object.values(levelData)) {
          if (Array.isArray(semesterCourses)) {
            coursesToMatch.push(...semesterCourses);
          }
        }
      }
    } else if (filterSemester) {
      for (const levelData of Object.values(this.departmentCourses.courses)) {
        const courses = levelData?.[filterSemester];
        if (courses) coursesToMatch.push(...courses);
      }
    } else {
      for (const levelData of Object.values(this.departmentCourses.courses)) {
        if (levelData && typeof levelData === 'object') {
          for (const semesterCourses of Object.values(levelData)) {
            if (Array.isArray(semesterCourses)) {
              coursesToMatch.push(...semesterCourses);
            }
          }
        }
      }
    }
    
    this.dbTitlesByFilter.set(cacheKey, coursesToMatch);
    return coursesToMatch;
  }

  showOnboardingPrompt() {
    if (document.getElementById('mivafocus-onboarding-overlay')) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'mivafocus-onboarding-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%; 
      background: rgba(0,0,0,0.6); z-index: 10000; display: flex; 
      align-items: center; justify-content: center; backdrop-filter: blur(4px);
    `;
    overlay.innerHTML = `
      <div style="
        background: white; padding: 2.5rem; border-radius: 12px; max-width: 450px; 
        text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      ">
        <div style="margin-bottom: 1.5rem;">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" style="margin: 0 auto;">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <h2 style="margin: 0 0 0.75rem 0; color: #1e40af; font-size: 1.5rem;">⚡ Welcome to MivaFocus!</h2>
        <p style="margin: 0 0 1.5rem 0; color: #6b7280; font-size: 1rem;">
          Filter your LMS courses by department and level
        </p>
        <p style="margin: 0 0 2rem 0; color: #374151; line-height: 1.6;">
          Click the <strong>MivaFocus extension icon</strong> in your browser toolbar to select your department and get started.
        </p>
        <button id="mf-onboarding-dismiss" style="
          background: #3b82f6; color: white; border: none; padding: 0.875rem 2rem; 
          border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 1rem;
          transition: background 0.2s;
        " onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">
          Got it!
        </button>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    document.getElementById('mf-onboarding-dismiss').addEventListener('click', () => {
      overlay.remove();
    });
  }

  extractLMSCourses() {
    const courseElements = this.findCourseElements();
    this.lmsCourses = [];
    
    for (const el of courseElements) {
      const title = this.extractCourseTitle(el);
      if (!title || title.length <= 5) continue;
      
      const normalizedFull = this.normalizeTitle(title);
      const courseCodes = this.extractAllCourseCodes(title);
      
      let descriptiveTitle = title;
      this.patterns.courseCode.lastIndex = 0;
      descriptiveTitle = title.replace(this.patterns.courseCode, '').replace(/^\s*[-—–:\s]*/, '').trim();
      
      const normalizedDesc = this.normalizeTitle(descriptiveTitle);
      
      this.lmsCourses.push({
        element: el,
        title,
        normalizedFull,
        normalizedDesc,
        codes: courseCodes
      });
    }
    
    console.log(`[MivaFocus] Extracted ${this.lmsCourses.length} courses from LMS`);
  }

  findCourseElements() {
    const primarySelector = '.card.dashboard-card[role="listitem"][data-region="course-content"]';
    let elements = Array.from(document.querySelectorAll(primarySelector));
    
    console.log(`[MivaFocus] Primary selector found ${elements.length} elements`);
    
    if (elements.length === 0) {
      const fallbackSelectors = [
        '.dashboard-card[data-region="course-content"]',
        '.card[role="listitem"][data-course-id]',
        'div[data-region="course-content"]',
        '.dashboard-card'
      ];
      
      for (const selector of fallbackSelectors) {
        elements = Array.from(document.querySelectorAll(selector));
        if (elements.length > 0) {
          console.log(`[MivaFocus] Fallback selector "${selector}" found ${elements.length} elements`);
          break;
        }
      }
    }

    const validated = elements.filter(el => {
      const hasMultiline = el.querySelector('.multiline');
      const hasCoursename = el.querySelector('.coursename');
      const hasCourseLink = el.querySelector('a[href*="/course/view.php"]');
      return hasMultiline || hasCoursename || hasCourseLink;
    });

    console.log(`[MivaFocus] Validated ${validated.length} course elements`);
    return validated.length > 0 ? validated : elements;
  }

  extractCourseTitle(courseEl) {
    const strategies = [
      () => courseEl.querySelector('.multiline')?.textContent.trim(),
      () => courseEl.querySelector('a.coursename')?.textContent.trim(),
      () => courseEl.querySelector('.coursename')?.textContent.trim(),
      () => courseEl.querySelector('a[href*="/course/view.php"]')?.textContent.trim(),
      () => courseEl.querySelector('span[title]')?.title.trim()
    ];

    for (const strategy of strategies) {
      try {
        const text = strategy();
        if (text && text.length > 5) {
          return text;
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  }

  normalizeTitle(title) {
    return title
      .toLowerCase()
      .replace(this.patterns.normalize, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  injectUI() {
    if (document.getElementById('mivafocus-control-bar')) return;

    const wrapper = document.querySelector('.all-filter-wrapper');
    if (!wrapper) {
      this.injectFallbackUI();
      return;
    }

    const navSearchSort = wrapper.querySelector('.nav-search-sort-selector');
    if (!navSearchSort) {
      this.injectFallbackUI();
      return;
    }

    const controlContainer = document.createElement('div');
    controlContainer.id = 'mivafocus-control-bar';
    controlContainer.className = 'd-flex align-items-center';
    controlContainer.style.marginLeft = '.1rem';
    controlContainer.innerHTML = `
      <div class="d-flex flex-wrap align-items-center">
        <div id="mf-filter-dropdown-container" class="dropdown ml-2" style="display: ${this.userSettings.filterEnabled ? 'block' : 'none'};">
          <button id="mivafocus-filter-dropdown" type="button" class="btn dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
            <span>Filter Courses</span>
          </button>
          <ul class="dropdown-menu">
            <li class="dropdown-item d-flex flex-column p-3" style="width: 300px;">
              <label for="mf-filter-level" class="font-weight-bold mb-1">Filter by Level</label>
              <select id="mf-filter-level" class="form-control mb-2">
                <option value="">All Levels</option>
                <option value="100">100 Level</option>
                <option value="200">200 Level</option>
                <option value="300">300 Level</option>
                <option value="400">400 Level</option>
                <option value="500">500 Level</option>
              </select>
              <label for="mf-filter-semester" class="font-weight-bold mb-1">Filter by Semester</label>
              <select id="mf-filter-semester" class="form-control mb-2">
                <option value="">All Semesters</option>
                <option value="first_semester">First Semester</option>
                <option value="second_semester">Second Semester</option>
              </select>
            </li>
          </ul>
        </div>
      </div>
    `;

    navSearchSort.appendChild(controlContainer);

    const dropdownMenu = controlContainer.querySelector('.dropdown-menu');
    if (dropdownMenu) {
      dropdownMenu.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) levelSelect.value = this.userSettings.filterLevel || '';
    if (semesterSelect) semesterSelect.value = this.userSettings.filterSemester || '';
    
    this.attachEventListeners();
  }

  injectFallbackUI() {
    const controlBar = document.createElement('div');
    controlBar.id = 'mivafocus-control-bar';
    controlBar.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; z-index: 1000; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-bottom: 2px solid rgba(255,255,255,0.2); padding: 0.75rem 1.5rem;
      display: flex; align-items: center; justify-content: space-between; 
      font-family: system-ui, -apple-system, sans-serif; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    
    controlBar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 1.5rem; flex: 1;">
        <div style="display: flex; align-items: center; gap: 0.5rem; font-weight: 700; color: white; font-size: 1.125rem;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
          <span>MivaFocus</span>
        </div>
        
        <div id="mf-filter-dropdown-container" style="display: ${this.userSettings.filterEnabled ? 'flex' : 'none'}; align-items: center; gap: 0.75rem; background: rgba(255,255,255,0.95); padding: 0.5rem 1rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
          </svg>
          <select id="mf-filter-level" style="padding: 0.375rem 0.75rem; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.875rem; min-width: 100px; background: white; cursor: pointer;">
            <option value="">All Levels</option>
            <option value="100">100 Level</option>
            <option value="200">200 Level</option>
            <option value="300">300 Level</option>
            <option value="400">400 Level</option>
            <option value="500">500 Level</option>
          </select>
          <select id="mf-filter-semester" style="padding: 0.375rem 0.75rem; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.875rem; min-width: 140px; background: white; cursor: pointer;">
            <option value="">All Semesters</option>
            <option value="first_semester">First Semester</option>
            <option value="second_semester">Second Semester</option>
          </select>
        </div>
      </div>
    `;

    document.body.insertBefore(controlBar, document.body.firstChild);
    document.body.style.paddingTop = '50px';
    
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) levelSelect.value = this.userSettings.filterLevel || '';
    if (semesterSelect) semesterSelect.value = this.userSettings.filterSemester || '';
    
    this.attachEventListeners();
  }

  attachEventListeners() {
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) {
      levelSelect.addEventListener('change', (e) => {
        this.userSettings.filterLevel = e.target.value;
        this.dbTitlesByFilter.clear();
        this.saveUserSettings();
        if (this.userSettings.filterEnabled) {
          this.applyFilter();
        }
      });
    }
    
    if (semesterSelect) {
      semesterSelect.addEventListener('change', (e) => {
        this.userSettings.filterSemester = e.target.value;
        this.dbTitlesByFilter.clear();
        this.saveUserSettings();
        if (this.userSettings.filterEnabled) {
          this.applyFilter();
        }
      });
    }
  }

  async handleSettingsUpdate(settings) {
    const oldDept = this.userSettings.department;
    const oldEnabled = this.userSettings.filterEnabled;
    
    this.userSettings = { ...this.userSettings, ...settings };
    await this.saveUserSettings();
    
    if (oldDept !== this.userSettings.department) {
      await this.loadDepartmentCourses();
      
      if (!oldDept && this.userSettings.department) {
        const overlay = document.getElementById('mivafocus-onboarding-overlay');
        if (overlay) overlay.remove();
        
        this.removeUI();
        this.injectUI();
        this.extractLMSCourses();
      }
    }
    
    const dropdownContainer = document.getElementById('mf-filter-dropdown-container');
    if (dropdownContainer) {
      dropdownContainer.style.display = this.userSettings.filterEnabled ? (dropdownContainer.classList ? 'block' : 'flex') : 'none';
    }
    
    const levelSelect = document.getElementById('mf-filter-level');
    const semesterSelect = document.getElementById('mf-filter-semester');
    
    if (levelSelect) levelSelect.value = this.userSettings.filterLevel || '';
    if (semesterSelect) semesterSelect.value = this.userSettings.filterSemester || '';
    
    this.dbTitlesByFilter.clear();
    
    if (this.userSettings.filterEnabled) {
      await this.applyFilter();
    } else if (oldEnabled !== this.userSettings.filterEnabled) {
      await this.applyFilter();
    }
  }

  async handleReset() {
    this.removeUI();
    document.body.style.paddingTop = '';
    
    this.userSettings = {
      department: null,
      filterEnabled: false,
      filterLevel: null,
      filterSemester: null,
      showStats: false,
      onboardingComplete: false
    };
    
    await this.saveUserSettings();
    
    this.departmentCourses = null;
    this.fullDatabase = null;
    this.normalizedDbCourses.clear();
    this.dbCodesSet.clear();
    this.dbCoursesByCode.clear();
    this.dbTitlesByFilter.clear();
    this.initialized = false;
    
    this.lmsCourses.forEach(course => {
      course.element.style.removeProperty('display');
      course.element.removeAttribute('data-mivafocus-filtered');
    });
    
    this.showOnboardingPrompt();
  }

  removeUI() {
    const controlBar = document.getElementById('mivafocus-control-bar');
    if (controlBar) controlBar.remove();
  }

  async applyFilter() {
    if (this.isFiltering) {
      console.log('[MivaFocus] Filter already in progress, skipping...');
      return;
    }
    this.isFiltering = true;

    try {
      this.extractLMSCourses();

      if (this.lmsCourses.length === 0) {
        console.warn('[MivaFocus] No courses found to filter');
        this.isFiltering = false;
        return;
      }

      this.stats.total = this.lmsCourses.length;
      this.stats.visible = 0;
      this.stats.hidden = 0;

      if (!this.userSettings.filterEnabled) {
        requestAnimationFrame(() => {
          for (const lmsCourse of this.lmsCourses) {
            lmsCourse.element.style.removeProperty('display');
            lmsCourse.element.removeAttribute('data-mivafocus-filtered');
            this.stats.visible++;
          }
          this.updateStatsDisplay();
          console.log('[MivaFocus] Filter disabled - showing all courses:', this.stats);
        });
        this.isFiltering = false;
        return;
      }

      const coursesToMatch = this.getFilteredCourses();

      const updates = this.lmsCourses.map(lmsCourse => ({
        element: lmsCourse.element,
        shouldShow: this.shouldShowCourse(lmsCourse, coursesToMatch)
      }));

      requestAnimationFrame(() => {
        for (const { element, shouldShow } of updates) {
          if (shouldShow) {
            element.style.removeProperty('display');
            element.setAttribute('data-mivafocus-filtered', 'false');
            this.stats.visible++;
          } else {
            element.style.display = 'none';
            element.setAttribute('data-mivafocus-filtered', 'true');
            this.stats.hidden++;
          }
        }

        this.updateStatsDisplay();
        console.log('[MivaFocus] Filter applied:', this.stats);
      });

    } catch (error) {
      console.error('[MivaFocus] Filter error:', error);
    } finally {
      this.isFiltering = false;
    }
  }

  shouldShowCourse(lmsCourse, coursesToMatch) {
    if (!this.userSettings.filterEnabled) {
      return true;
    }
    
    if (!this.departmentCourses?.courses) {
      return true;
    }
    
    const { filterLevel, filterSemester } = this.userSettings;
    if (!filterLevel && !filterSemester) {
      return true;
    }
    
    if (!coursesToMatch || coursesToMatch.length === 0) {
      return false;
    }

    return this.matchCourse(lmsCourse, coursesToMatch);
  }

  matchCourse(lmsCourse, coursesToMatch) {
    const lmsFullLower = lmsCourse.normalizedFull;
    const lmsDescLower = lmsCourse.normalizedDesc;
    const lmsCodes = lmsCourse.codes || [];
    
    // Priority 1: EXACT course code match - handles borrowed courses from ANY department
    for (const lmsCode of lmsCodes) {
      if (this.dbCodesSet.has(lmsCode)) {
        const matchingCourses = this.dbCoursesByCode.get(lmsCode) || [];
        
        for (const dbCourse of matchingCourses) {
          const isInFilteredList = coursesToMatch.some(c => c.title === dbCourse.original);
          if (isInFilteredList) {
            console.log(`[MivaFocus] ✓ Code match: "${lmsCourse.title}" [${lmsCode}] -> "${dbCourse.original}" (${dbCourse.department} ${dbCourse.level})`);
            return true;
          }
        }
      }
    }
    
    // Build optimized lookup structures for title matching
    const dbTitleSet = new Set();
    const dbTitleList = [];
    
    for (const dbCourse of coursesToMatch) {
      if (!dbCourse?.title) continue;
      
      const dbData = this.normalizedDbCourses.get(dbCourse.title);
      if (!dbData) continue;
      
      dbTitleSet.add(dbData.normalized);
      dbTitleList.push(dbData);
    }
    
    // Priority 2: EXACT descriptive title match
    if (dbTitleSet.has(lmsDescLower)) {
      console.log(`[MivaFocus] ✓ Descriptive title match: "${lmsCourse.title}"`);
      return true;
    }
    
    // Priority 3: EXACT full title match
    if (dbTitleSet.has(lmsFullLower)) {
      console.log(`[MivaFocus] ✓ Full title match: "${lmsCourse.title}"`);
      return true;
    }
    
    // Priority 4: Fuzzy matching with strict criteria
    const lmsWords = lmsDescLower.split(/\s+/).filter(w => w.length > 2);
    if (lmsWords.length < 2) return false;
    
    const lmsNumeric = this.extractSequenceNumbers(lmsDescLower);
    const lmsTextWords = lmsWords.filter(w => !this.isNumericToken(w));
    const lmsSet = new Set(lmsTextWords);
    
    const commonWords = new Set(['introduction', 'principles', 'general', 'basic', 'advanced', 
                                  'course', 'studies', 'for', 'and', 'the', 'of', 'in', 'to', 'miva']);
    const lmsKeyWords = new Set([...lmsSet].filter(w => !commonWords.has(w)));
    
    for (const dbData of dbTitleList) {
      const dbNormalized = dbData.normalized;
      const dbWords = dbNormalized.split(/\s+/).filter(w => w.length > 2);
      
      if (dbWords.length < 2) continue;
      
      const dbNumeric = this.extractSequenceNumbers(dbNormalized);
      
      if (lmsNumeric.length > 0 || dbNumeric.length > 0) {
        const lmsNumStr = lmsNumeric.sort().join(',');
        const dbNumStr = dbNumeric.sort().join(',');
        
        if (lmsNumStr !== dbNumStr) {
          continue;
        }
      }
      
      const dbTextWords = dbWords.filter(w => !this.isNumericToken(w));
      const dbSet = new Set(dbTextWords);
      const dbKeyWords = new Set([...dbSet].filter(w => !commonWords.has(w)));
      
      let keyWordMatches = 0;
      for (const word of lmsKeyWords) {
        if (dbKeyWords.has(word)) keyWordMatches++;
      }
      
      let allWordMatches = 0;
      for (const word of lmsSet) {
        if (dbSet.has(word)) allWordMatches++;
      }
      
      const minKeyWords = Math.min(lmsKeyWords.size, dbKeyWords.size);
      const minAllWords = Math.min(lmsSet.size, dbSet.size);
      
      if (minAllWords === 0) continue;
      
      const allWordRatio = allWordMatches / minAllWords;
      const keyWordRatio = minKeyWords > 0 ? keyWordMatches / minKeyWords : 0;
      
      let requiredAllRatio = 0.85;
      let requiredKeyRatio = 0.8;
      let minMatchingWords = 3;
      
      if (minAllWords >= 4) {
        requiredAllRatio = 0.8;
        requiredKeyRatio = 0.75;
        minMatchingWords = 3;
      } else if (minAllWords === 2) {
        requiredAllRatio = 1.0;
        requiredKeyRatio = 1.0;
        minMatchingWords = 2;
      }
      
      if (allWordRatio >= requiredAllRatio && 
          (minKeyWords === 0 || keyWordRatio >= requiredKeyRatio) &&
          allWordMatches >= minMatchingWords) {
        console.log(`[MivaFocus] ✓ Fuzzy match: "${lmsCourse.title}" -> "${dbData.original}" (ratio: ${allWordRatio.toFixed(2)})`);
        return true;
      }
    }
    
    return false;
  }
  
  extractSequenceNumbers(str) {
    const matches = str.match(this.patterns.numericSequence) || [];
    return matches.map(m => this.normalizeSequenceNumber(m));
  }
  
  normalizeSequenceNumber(token) {
    const lower = token.toLowerCase();
    return this.romanMap[lower] || token;
  }
  
  isNumericToken(word) {
    return /^\d+$/.test(word) || this.patterns.romanNumeral.test(word);
  }

  updateStatsDisplay() {
    const visibleEl = document.getElementById('mf-visible-count');
    const hiddenEl = document.getElementById('mf-hidden-count');
    
    if (visibleEl) visibleEl.textContent = this.stats.visible;
    if (hiddenEl) hiddenEl.textContent = this.stats.hidden;
  }

  observeDOMChanges() {
    if (this.observer) return;
    
    this.observer = new MutationObserver((mutations) => {
      const relevantChange = mutations.some(mutation => {
        if (mutation.type !== 'childList') return false;
        
        return Array.from(mutation.addedNodes).some(node => {
          return node.nodeType === 1 && (
            node.classList?.contains('dashboard-card') ||
            node.querySelector?.('.dashboard-card') ||
            (node.hasAttribute?.('data-region') && 
             node.getAttribute('data-region').includes('course'))
          );
        });
      });

      if (!relevantChange || !this.userSettings.filterEnabled || this.isFiltering) return;

      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        console.log('[MivaFocus] DOM changed, re-applying filter...');
        this.extractLMSCourses();
        this.applyFilter();
      }, 300);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    console.log('[MivaFocus] DOM observer initialized');
  }
}

// Initialize on page load
(function() {
  const filter = new MivaFocusFilter();
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => filter.init());
  } else {
    filter.init();
  }
})();