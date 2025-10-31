"""
MIVA Course Scraper - Main Scraping Module
==========================================
Scrapes course data from MIVA Open University website.
"""

import requests
from bs4 import BeautifulSoup
import re
from datetime import datetime
from typing import Dict, List, Optional
import logging
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

# Import settings
import settings

# Configure logging
file_handler = logging.FileHandler(settings.LOG_FILE, encoding=settings.LOG_ENCODING)
stream_handler = logging.StreamHandler(sys.stdout)

# Set UTF-8 encoding for console output on Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding=settings.LOG_ENCODING, errors='replace')

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper()),
    format=settings.LOG_FORMAT,
    handlers=[file_handler, stream_handler]
)
logger = logging.getLogger(__name__)


class MivaCourseScraper:
    """Scraper for MIVA Open University course data"""
    
    def __init__(self, base_url: str = "", timeout: int = 0, max_workers: int = 0, parser: str = ""):
        self.base_url = base_url or settings.BASE_URL
        self.timeout = timeout or settings.TIMEOUT
        self.max_workers = max_workers or settings.MAX_WORKERS
        self.parser = parser or settings.PARSER
        
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': settings.USER_AGENT
        })
        
        # This dict will be populated and returned
        self.courses_data = {
            "metadata": {
                **settings.METADATA,
                "lastUpdated": "",  # Will be set upon completion
            },
            "faculties": {}
        }
        
        # --- Pre-compiled Regex for efficiency ---
        self.RE_FACULTIES_CHILD = re.compile(r'faculties-child')
        self.RE_ELEMENTOR_ELEMENT = re.compile(r'elementor-element')
        self.RE_ACCORDION_ITEM = re.compile(r'elementor-accordion-item')
        self.RE_TAB_CONTENT = re.compile(r'elementor-tab-content')
        self.RE_LEVEL_TITLE = re.compile(r'\b([12345])00\s*level\b', re.IGNORECASE)
        self.RE_FIRST_DIGIT = re.compile(r'(\d+)')
        self.RE_HAS_DIGIT = re.compile(r'\d+')

    def _make_request(self, url: str, retries: int = 0) -> Optional[requests.Response]:
        """Make HTTP request with retry logic"""
        retries = retries or settings.MAX_RETRIES
        
        for attempt in range(retries):
            try:
                response = self.session.get(url, timeout=self.timeout)
                response.raise_for_status()
                return response
            except requests.RequestException as e:
                if attempt < retries - 1:
                    logger.warning(f"Request failed (attempt {attempt + 1}/{retries}): {e}")
                    time.sleep(settings.RETRY_DELAY)
                else:
                    logger.error(f"Request failed after {retries} attempts: {e}")
                    return None

    def scrape_faculties_page(self, faculties_url: str) -> List[Dict]:
        """Scrape main faculties page to extract all faculties and departments"""
        logger.info(f"Scraping faculties from: {faculties_url}")
        
        response = self._make_request(faculties_url)
        if not response:
            return []
        
        try:
            soup = BeautifulSoup(response.content, self.parser)
            
            faculties = []
            faculty_sections = soup.find_all('div', class_=self.RE_FACULTIES_CHILD)
            
            for section in faculty_sections:
                heading = section.find(['h2'], class_='elementor-heading-title')
                if heading and 'school' in heading.text.lower():
                    faculty_name = heading.text.strip()
                    logger.info(f"Found faculty: {faculty_name}")
                    
                    container = section.find_parent('div', class_=self.RE_ELEMENTOR_ELEMENT)
                    if container:
                        dept_list = container.find_next('ul', class_='elementor-icon-list-items')
                        
                        if dept_list:
                            departments = []
                            for dept_item in dept_list.find_all('li', class_='elementor-icon-list-item'):
                                link = dept_item.find('a')
                                if link:
                                    dept_text = dept_item.get_text(strip=True)
                                    dept_url = str(link.get('href', ''))
                                    dept_code = self._extract_dept_code(dept_text, dept_url)
                                    
                                    departments.append({
                                        'name': dept_text,
                                        'code': dept_code,
                                        'url': dept_url
                                    })
                            
                            faculties.append({
                                'name': faculty_name,
                                'departments': departments
                            })
            
            logger.info(f"Successfully scraped {len(faculties)} faculties")
            return faculties
            
        except Exception as e:
            logger.error(f"Unexpected error scraping faculties: {e}", exc_info=True)
            return []
    
    def _extract_dept_code(self, dept_name: str, url: str = "") -> str:
        """Extract standardized department code from name or URL"""
        dept_lower = dept_name.lower()
        
        # Try exact matches first from settings
        for key, code in settings.DEPARTMENT_CODES.items():
            if key in dept_lower:
                return code
        
        # Try URL matching
        if url:
            url_lower = url.lower()
            for key, code in settings.DEPARTMENT_CODES.items():
                if key.replace(' ', '-') in url_lower:
                    return code
        
        # Generate acronym from capital letters
        words = re.findall(r'\b[A-Z][a-z]*', dept_name)
        if words:
            return ''.join(word[0] for word in words[:3]).upper()
        
        logger.warning(f"Could not determine code for department: {dept_name}")
        return "UNK"
    
    def scrape_department_page(self, dept_url: str, dept_name: str) -> Dict:
        """Scrape individual department page for course data"""
        
        response = self._make_request(dept_url)
        if not response:
            raise Exception(f"Failed to fetch {dept_name}")
        
        try:
            soup = BeautifulSoup(response.content, self.parser)
            
            courses_by_level = {}
            accordion_items = soup.find_all('div', class_=self.RE_ACCORDION_ITEM)
            
            for accordion in accordion_items:
                title_elem = accordion.find('a', class_='elementor-accordion-title')
                if not title_elem:
                    title_elem = accordion.find('span', class_='elementor-accordion-title')
                
                if title_elem:
                    title_text = title_elem.get_text(strip=True)
                    level_match = self.RE_LEVEL_TITLE.search(title_text)
                    
                    if level_match:
                        level = f"{level_match.group(1)}00_Level"
                        content_div = accordion.find('div', class_=self.RE_TAB_CONTENT)
                        
                        if content_div:
                            courses_by_semester = self._extract_courses_from_tables(content_div)
                            
                            if courses_by_semester:
                                courses_by_level[level] = courses_by_semester
            
            return courses_by_level
            
        except Exception as e:
            raise Exception(f"Error scraping {dept_name}: {e}") from e
    
    def _extract_courses_from_tables(self, content_div) -> Dict:
        """Extract courses organized by semester from content div"""
        courses_by_semester = {}
        tables = content_div.find_all('table', class_='curriculum-table')
        
        if not tables:
            tables = content_div.find_all('table')
        
        for idx, table in enumerate(tables):
            semester = self._detect_table_semester(table, idx)
            
            if semester:
                courses = self._parse_table_courses(table)
                
                if semester not in courses_by_semester:
                    courses_by_semester[semester] = []
                
                courses_by_semester[semester].extend(courses)
        
        return courses_by_semester
    
    def _detect_table_semester(self, table, table_index: int) -> Optional[str]:
        """Detect which semester a table belongs to"""
        sem_string = 'semester'
        
        # Check HTML comments before table
        for sibling in table.previous_siblings:
            if hasattr(sibling, 'string') and sibling.string:
                comment_text = sibling.string.strip().lower()
                if '1st semester' in comment_text or 'first semester' in comment_text:
                    return f'first_{sem_string}'
                elif '2nd semester' in comment_text or 'second semester' in comment_text:
                    return f'second_{sem_string}'
        
        # Check table header
        thead = table.find('thead')
        if thead:
            for th in thead.find_all('th'):
                th_text = th.get_text(strip=True).lower()
                if '1st semester' in th_text or 'first semester' in th_text:
                    return f'first_{sem_string}'
                elif '2nd semester' in th_text or 'second semester' in th_text:
                    return f'second_{sem_string}'
        
        # Check first row
        first_row = table.find('tr')
        if first_row:
            row_text = first_row.get_text(strip=True).lower()
            if '1st semester' in row_text or 'first semester' in row_text:
                    return f'first_{sem_string}'
            elif '2nd semester' in row_text or 'second semester' in row_text:
                    return f'second_{sem_string}'
        
        # Fallback to table position
        if table_index == 0:
            return f'first_{sem_string}'
        elif table_index == 1:
            return f'second_{sem_string}'
        else:
            return None
    
    def _parse_table_courses(self, table) -> List[Dict]:
        """Parse course information from table rows"""
        courses = []
        tbody = table.find('tbody') or table
        
        # Try finding rows with accordion-header class (most common)
        accordion_rows = tbody.find_all('tr', class_='accordion-header')
        
        # Fallback: find all rows with 2 td cells
        if not accordion_rows:
            accordion_rows = []
            for row in tbody.find_all('tr'):
                cells = row.find_all('td')
                
                if len(cells) == 2:
                    first_text = cells[0].get_text(strip=True)
                    second_text = cells[1].get_text(strip=True)
                    
                    # Valid course row: substantial title + numeric units
                    if first_text and len(first_text) > 3 and self.RE_HAS_DIGIT.search(second_text):
                        accordion_rows.append(row)
        
        # Extract course data
        for row in accordion_rows:
            cells = row.find_all('td')
            
            if len(cells) >= 2:
                title = cells[0].get_text(strip=True)
                units_text = cells[1].get_text(strip=True)
                
                units_match = self.RE_FIRST_DIGIT.search(units_text)
                if units_match and title:
                    courses.append({
                        'title': title,
                        'creditUnits': int(units_match.group(1))
                    })
        
        return courses
    
    def scrape_all(self, faculties_url: Optional[str] = None) -> Dict:
        """Main scraping method - scrapes all faculties and departments concurrently"""
        faculties_url = faculties_url or settings.FACULTIES_URL
        
        logger.info("=" * 70)
        logger.info("MIVA OPEN UNIVERSITY COURSE SCRAPER - STARTING")
        logger.info(f"Mode: Concurrent (max_workers={self.max_workers}), Parser: {self.parser}")
        logger.info("=" * 70)
        
        faculties = self.scrape_faculties_page(faculties_url)
        
        if not faculties:
            logger.error("No faculties found. Scraping failed.")
            return self.courses_data
        
        for faculty in faculties:
            faculty_name = faculty['name']
            logger.info(f"\n{faculty_name}")
            logger.info("-" * 70)
            
            self.courses_data['faculties'][faculty_name] = {'departments': {}}
            
            # --- Concurrent Scraping Block ---
            with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
                future_to_dept = {}
                
                for dept in faculty['departments']:
                    dept_name = dept['name']
                    dept_code = dept['code']
                    dept_url = dept['url']
                    
                    if dept_url.startswith('/'):
                        dept_url = self.base_url + dept_url
                    
                    logger.info(f"Submitting job for {dept_code}: {dept_name}")
                    future = executor.submit(self.scrape_department_page, dept_url, dept_name)
                    future_to_dept[future] = (dept_code, dept_name, dept_url)
                
                # Process results as they complete
                for future in as_completed(future_to_dept):
                    dept_code, dept_name, dept_url = future_to_dept[future]
                    try:
                        courses = future.result()
                        
                        if courses:
                            self.courses_data['faculties'][faculty_name]['departments'][dept_code] = {
                                'name': dept_name,
                                'url': dept_url,
                                'courses': courses
                            }
                            dept_total = sum(
                                len(semester_courses)
                                for level_data in courses.values()
                                for semester_courses in level_data.values()
                            )
                            logger.info(f"[OK] {dept_code}: {dept_total} courses found")
                        else:
                            logger.warning(f"[SKIP] {dept_code}: No courses found")
                    
                    except Exception as e:
                        logger.error(f"[FAIL] {dept_code} ({dept_name}): {e}")
            # --- End Concurrent Block ---

        # --- Summary Report ---
        total_departments = 0
        total_courses = 0
        for faculty_data in self.courses_data['faculties'].values():
            for dept_data in faculty_data['departments'].values():
                total_departments += 1
                dept_total = sum(
                    len(semester_courses)
                    for level_data in dept_data['courses'].values()
                    for semester_courses in level_data.values()
                )
                total_courses += dept_total

        logger.info("\n" + "=" * 70)
        logger.info(f"SCRAPING COMPLETED SUCCESSFULLY")
        logger.info(f"Total Departments: {total_departments}")
        logger.info(f"Total Courses: {total_courses}")
        logger.info("=" * 70)
        
        # Set final timestamp
        self.courses_data['metadata']['lastUpdated'] = datetime.now().strftime("%B %d, %Y %H:%M:%S")
        
        return self.courses_data