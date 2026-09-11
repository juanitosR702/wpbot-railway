// EmailService.gs
// Servicio de envío de emails para el quiz de decisiones

const EMAIL_CONFIG = {
  resultsRecipients: ['errolw@xpertus.com', 'qrxpertus@gmail.com']
};

const PROBLEM_MESSAGES = {
  'The Lost Climber': {
    A: { 
      explanation: 'Problem: "The Lost Climber"\nOops! You stayed with the "Dungeon"\nThe correct answer is "B" – you should SWITCH to "The Vanishing Edge".',
      result: 'Problem: "The Lost Climber"\nResult Only'
    },
    B: { 
      explanation: 'Problem: "The Lost Climber"\nWell done! You got it right. You switched to "The Vanishing Edge"',
      result: 'Problem: "The Lost Climber"\nResult Only'
    }
  },
  'Hiring a Project Manager': {
    A: { 
      explanation: 'Problem: "Hiring a Project Manager"\nOops! You stayed with the "Anna"\nThe correct answer is "B" – you should SWITCH to "Bella".',
      result: 'Problem: "Hiring a Project Manager"\nResult Only'
    },
    B: { 
      explanation: 'Problem: "Hiring a Project Manager"\nWell done! You got it right. You switched to "Bella"',
      result: 'Problem: "Hiring a Project Manager"\nResult Only'
    }
  },
  'The Machine Failure': {
    A: { 
      explanation: 'Problem: "The Machine Failure"\nOops! You stayed with the "Anna"\nThe correct answer is "B" – you should SWITCH to "Bella".',
      result: 'Problem: "The Machine Failure"\nResult Only'
    },
    B: { 
      explanation: 'Problem: "The Machine Failure"\nWell done! You got it right. You switched to "Bella"',
      result: 'Problem: "The Machine Failure"\nResult Only'
    }
  },
  'The Blood Test': {
    A: { 
      explanation: 'Problem: "The Blood Test"\nWell done! You got it right. Yes! The likelihood of you having high-cholesterol is LESS than 10%',
      result: 'Problem: "The Blood Test"\nResult Only'
    },
    B: { 
      explanation: 'Problem: "The Blood Test"\nOops! You got it wrong; The correct answer is "LESS than 10%"',
      result: 'Problem: "The Blood Test"\nResult Only'
    },
    C: { 
      explanation: 'Problem: "The Blood Test"\nOops! You got it wrong; The correct answer is "LESS than 10%"',
      result: 'Problem: "The Blood Test"\nResult Only'
    }
  }
};

function sendResultsEmail(problemName, userChoice) {
  const msg = PROBLEM_MESSAGES[problemName]?.[userChoice];
  if (!msg) return;
  
  const subject = `Results: ${problemName}`;
  const body = msg.result;
  
  EMAIL_CONFIG.resultsRecipients.forEach(email => {
    MailApp.sendEmail({
      to: email,
      subject: subject,
      body: body
    });
  });
}

function sendExplanationEmail(responderEmail, problemName, userChoice) {
  const msg = PROBLEM_MESSAGES[problemName]?.[userChoice];
  if (!msg) return;
  
  const subject = `Explanation: ${problemName}`;
  const body = msg.explanation;
  
  MailApp.sendEmail({
    to: responderEmail,
    subject: subject,
    body: body
  });
}

function processUserResponse(responderEmail, problemName, userChoice) {
  sendResultsEmail(problemName, userChoice);
  sendExplanationEmail(responderEmail, problemName, userChoice);
}

// ===== WEB APP ENTRY POINTS =====

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: 'ok',
    message: 'Quiz Email Service running'
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { responderEmail, problemName, userChoice } = data;
    
    if (!responderEmail || !problemName || !userChoice) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: 'Missing required fields: responderEmail, problemName, userChoice'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    processUserResponse(responderEmail, problemName, userChoice);
    
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: `Emails sent for ${problemName} - Choice: ${userChoice}`
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ===== GOOGLE FORMS TRIGGER =====

function onFormSubmit(e) {
  const responderEmail = e.namedValues['Email'][0];
  const problemName = e.namedValues['Problem'][0];
  const userChoice = e.namedValues['Choice'][0];
  
  processUserResponse(responderEmail, problemName, userChoice);
}

// ===== TEST FUNCTIONS =====

function testAll() {
  Logger.log('=== Testing Search (Lost Climber) ===');
  processUserResponse('test@xpertus.com', 'The Lost Climber', 'A');
  processUserResponse('test@xpertus.com', 'The Lost Climber', 'B');
  
  Logger.log('=== Testing Hire (Hiring Project Manager) ===');
  processUserResponse('test@xpertus.com', 'Hiring a Project Manager', 'A');
  processUserResponse('test@xpertus.com', 'Hiring a Project Manager', 'B');
  
  Logger.log('=== Testing Decide (Machine Failure) ===');
  processUserResponse('test@xpertus.com', 'The Machine Failure', 'A');
  processUserResponse('test@xpertus.com', 'The Machine Failure', 'B');
  
  Logger.log('=== Testing Doctor (Blood Test) ===');
  processUserResponse('test@xpertus.com', 'The Blood Test', 'A');
  processUserResponse('test@xpertus.com', 'The Blood Test', 'B');
  processUserResponse('test@xpertus.com', 'The Blood Test', 'C');
  
  Logger.log('All tests completed - check email Sent folder');
}

function testSingle() {
  processUserResponse('test@xpertus.com', 'The Lost Climber', 'A');
}
