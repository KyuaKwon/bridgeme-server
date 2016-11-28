import bodyParser from 'body-parser';
import compress from 'compression';
import express from 'express';
import mongoose from './config/mongoose';
import morgan from 'morgan';
import methodOverride from 'method-override';
import users from './routes/users.route';
import survey from './routes/survey.route';
import match from './routes/match.route';
import chat from './routes/chat.route';

export default (cb) => {
  const app = express();
  const db = mongoose();

  if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
  } else if (process.env.NODE_ENV === 'production') {
    app.use(compress());
  }

  app.use(bodyParser.urlencoded({
    extended: true,
  }));
  app.use(bodyParser.json());
  app.use(methodOverride());

  app.use('/users', users);
  app.use('/survey', survey);
  app.use('/match', match);
  app.use('/chat', chat);

  app.use(express.static(__dirname + '/apidoc'));

  const server = app.listen(process.env.NODE_ENV === 'test' ? 8000 : 80, cb ? cb : () => {
    /* eslint-disable no-console */
    console.log(`Listening on port 8000`);
    /* eslint-enable */
  });

  return server;
};
