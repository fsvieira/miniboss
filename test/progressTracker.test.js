const { ProgressTracker } = require('../services/progressService');

describe('ProgressTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new ProgressTracker(20, 3);
  });

  test('should initialize with default values', () => {
    expect(tracker.state.baseMaxIterations).toBe(20);
    expect(tracker.state.currentMaxIterations).toBe(20);
    expect(tracker.state.maxExtensions).toBe(3);
    expect(tracker.state.todoList).toEqual([]);
    expect(tracker.state.consecutiveNoProgress).toBe(0);
  });

  describe('analyzeToolCall', () => {
    test('should return progress for new readFile', () => {
      const result = tracker.analyzeToolCall('readFile', { filePath: 'test.js' }, 'content');
      expect(result.hasProgress).toBe(true);
      expect(result.score).toBe(1);
      expect(result.reason).toBe('Nova leitura de ficheiro');
      expect(result.isRepeated).toBe(false);
    });

    test('should penalize repeated readFile', () => {
      tracker.analyzeToolCall('readFile', { filePath: 'test.js' }, 'content');
      const result = tracker.analyzeToolCall('readFile', { filePath: 'test.js' }, 'content');
      expect(result.hasProgress).toBe(false);
      expect(result.score).toBe(-1);
      expect(result.reason).toBe('Ficheiro já lido anteriormente');
      expect(result.isRepeated).toBe(true);
    });

    test('should return progress for writeFile', () => {
      const result = tracker.analyzeToolCall('writeFile', { filePath: 'test.js' }, 'success');
      expect(result.hasProgress).toBe(true);
      expect(result.score).toBe(3);
      expect(result.reason).toBe('Ficheiro modificado/criado');
    });

    test('should return progress for useful searchInFiles', () => {
      const result = tracker.analyzeToolCall('searchInFiles', { pattern: 'test' }, 'match found');
      expect(result.hasProgress).toBe(true);
      expect(result.score).toBe(1);
      expect(result.reason).toBe('Pesquisa com resultados úteis');
    });

    test('should not return progress for empty searchInFiles', () => {
      const result = tracker.analyzeToolCall('searchInFiles', { pattern: 'test' }, '');
      expect(result.hasProgress).toBe(false);
      expect(result.score).toBe(0);
      expect(result.reason).toBe('Pesquisa sem resultados');
    });

    test('should penalize repeated searchInFiles', () => {
      tracker.analyzeToolCall('searchInFiles', { pattern: 'test' }, 'match');
      const result = tracker.analyzeToolCall('searchInFiles', { pattern: 'test' }, 'match');
      expect(result.hasProgress).toBe(false);
      expect(result.score).toBe(-0.5);
      expect(result.reason).toBe('Pesquisa repetida');
    });
  });

  describe('updateProgress', () => {
    test('should update totalProgressScore and reset consecutiveNoProgress on progress', () => {
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 1);
      expect(tracker.state.totalProgressScore).toBe(1);
      expect(tracker.state.consecutiveNoProgress).toBe(0);
    });

    test('should increment consecutiveNoProgress on no progress', () => {
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 1); // Progress
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 2); // No progress (repeated read)
      expect(tracker.state.totalProgressScore).toBe(1); // Score remains 1 due to repetition penalty
      expect(tracker.state.consecutiveNoProgress).toBe(1);
    });
  });

  describe('updateTodoList', () => {
    test('should update todo list and categorize tasks', () => {
      const tasks = [
        { id: '1', description: 'Task 1', status: 'pending' },
        { id: '2', description: 'Task 2', status: 'in_progress' },
      ];
      tracker.updateTodoList(tasks, 1);
      expect(tracker.state.todoList.length).toBe(2);
      expect(tracker.state.pendingTasks.length).toBe(1);
      expect(tracker.state.inProgressTasks.length).toBe(1);
      expect(tracker.state.completedTasks.length).toBe(0);
    });

    test('should mark completed tasks with completedAt and iterationCompleted', () => {
      const tasks1 = [
        { id: '1', description: 'Task 1', status: 'pending' },
      ];
      tracker.updateTodoList(tasks1, 1);

      const tasks2 = [
        { id: '1', description: 'Task 1', status: 'completed' },
      ];
      tracker.updateTodoList(tasks2, 2);

      expect(tracker.state.completedTasks.length).toBe(1);
      expect(tracker.state.completedTasks[0].id).toBe('1');
      expect(tracker.state.completedTasks[0].completedAt).toBeDefined();
      expect(tracker.state.completedTasks[0].iterationCompleted).toBe(2);
    });
  });

  describe('shouldSuggestTaskBreakdown', () => {
    test('should suggest task breakdown after 3 consecutive no progress iterations', () => {
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 1);
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 2);
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 3);
      tracker.updateProgress('readFile', { filePath: 'file1.js' }, 'content', 4);
      expect(tracker.shouldSuggestTaskBreakdown().isStagnant).toBe(true);
      expect(tracker.shouldSuggestTaskBreakdown().level).toBe('warning');
    });
  });

  describe('shouldExtendIterations', () => {
    test('should extend iterations if near limit and progress is being made', () => {
      tracker.state.currentMaxIterations = 20;
      tracker.state.lastProgressIteration = 17;
      tracker.state.totalProgressScore = 5; // Positive progress
      tracker.state.consecutiveNoProgress = 0;

      // Simulate being at iteration 18 (near max 20)
      const result = tracker._shouldExtendIterations(18);
      expect(result).toBe(true);
      expect(tracker.state.currentMaxIterations).toBe(25);
      expect(tracker.state.extendedIterations).toBe(1);
    });

    test('should not extend iterations if max extensions reached', () => {
      tracker.state.extendedIterations = 3;
      tracker.state.currentMaxIterations = 20;
      tracker.state.lastProgressIteration = 17;
      tracker.state.totalProgressScore = 5;

      const result = tracker._shouldExtendIterations(18);
      expect(result).toBe(false);
      expect(tracker.state.currentMaxIterations).toBe(20);
    });

    test('should not extend iterations if no recent progress', () => {
      tracker.state.currentMaxIterations = 20;
      tracker.state.lastProgressIteration = 10; // No recent progress
      tracker.state.totalProgressScore = 5;
      tracker.state.consecutiveNoProgress = 0;

      const result = tracker._shouldExtendIterations(18);
      expect(result).toBe(false);
      expect(tracker.state.currentMaxIterations).toBe(20);
    });
  });

  describe('generateReport', () => {
    test('should generate a comprehensive report', () => {
      tracker.updateTodoList([
        { id: '1', description: 'Completed Task', status: 'completed' },
        { id: '2', description: 'Pending Task', status: 'pending' },
        { id: '3', description: 'In Progress Task', status: 'in_progress' },
      ], 5);
      tracker.state.totalProgressScore = 10;
      tracker.state.extendedIterations = 1;
      tracker.state.consecutiveNoProgress = 2;

      const report = tracker.generateReport(20);

      expect(report.completedTasks.length).toBe(1);
      expect(report.pendingTasks.length).toBe(1);
      expect(report.inProgressTasks.length).toBe(1);
      expect(report.statistics.totalIterations).toBe(20);
      expect(report.statistics.totalProgressScore).toBe(10);
      expect(report.reasonForStopping).toContain('20');
      expect(report.nextSteps).toBeDefined();
    });
  });

  describe('extractRelevantFiles', () => {
    test('should extract relevant files based on pending tasks', () => {
      tracker.updateTodoList([
        { id: '1', description: 'Modify authService.js', status: 'pending' },
      ], 1);

      const messages = [
        { role: 'tool', tool_name: 'readFile', content: 'file content', tool_args: JSON.stringify({ filePath: 'server/services/authService.js' }) },
        { role: 'tool', tool_name: 'readFile', content: 'file content', tool_args: JSON.stringify({ filePath: 'server/utils/helpers.js' }) },
      ];

      const relevantFiles = tracker.extractRelevantFiles(messages);
      expect(relevantFiles).toEqual(['server/services/authService.js']);
    });

    test('should extract relevant files from content', () => {
      tracker.updateTodoList([
        { id: '1', description: 'Check main.js for issues', status: 'pending' },
      ], 1);

      const messages = [
        { role: 'tool', content: 'Path: src/main.js' },
      ];

      const relevantFiles = tracker.extractRelevantFiles(messages);
      expect(relevantFiles).toEqual(['src/main.js']);
    });
  });
});