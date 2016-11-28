import express from 'express';
import jwtUtil from '../utils/jwt.util';
import * as user from '../controllers/users.controller';

/*
 * Define the URL routing for http://yoda-domain.com/users/*
 */

const router = express.Router();

router.post('/callback', (req, res, next) => {
  console.log(req.body);
  res.status(200).json();
});

export default router;
